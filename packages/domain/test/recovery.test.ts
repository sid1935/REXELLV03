import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_BITS,
  canonicalRecoveryCode,
  formatRecoveryCode,
  normaliseRecoveryCode,
} from '../src/recovery.js';

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe('formatting a recovery code', () => {
  it('produces something a person can read off paper', () => {
    const code = formatRecoveryCode(bytes(7));
    expect(code).toMatch(/^RXL(-[0-9A-Z]{5}){4}$/);
  });

  it('carries 100 bits', () => {
    expect(RECOVERY_CODE_BITS).toBe(100);
  });

  it('never emits the characters people misread', () => {
    // I, L, O and U are absent from Crockford base32 precisely because the
    // first three are indistinguishable from 1 and 0 in most faces.
    //
    // The check is on the body, not the whole string: the RXL prefix contains
    // an L, which is fine because normalisation strips the prefix before it
    // maps L to 1 — and no body can start with RXL, since L is not in the
    // alphabet.
    for (let i = 0; i < 256; i += 7) {
      const body = formatRecoveryCode(bytes(i)).replace(/^RXL-/, '');
      expect(body).not.toMatch(/[ILOU]/);
    }
  });

  it('refuses to build one from too little entropy', () => {
    expect(() => formatRecoveryCode(new Uint8Array(4))).toThrow(/at least/);
  });
});

describe('reading back what somebody typed', () => {
  const code = 'RXL-2W3K9-8HT4M-QRZ57-PN6VX';

  it('accepts it exactly as printed', () => {
    expect(normaliseRecoveryCode(code)).toBe('2W3K98HT4MQRZ57PN6VX');
  });

  it.each([
    ['lower case', 'rxl-2w3k9-8ht4m-qrz57-pn6vx'],
    ['no prefix', '2W3K9-8HT4M-QRZ57-PN6VX'],
    ['spaces for hyphens', 'RXL 2W3K9 8HT4M QRZ57 PN6VX'],
    ['run together', 'RXL2W3K98HT4MQRZ57PN6VX'],
    ['ragged whitespace', '  rxl-2w3k9 8HT4M-qrz57  pn6vx '],
  ])('accepts it %s', (_label, input) => {
    expect(normaliseRecoveryCode(input)).toBe(normaliseRecoveryCode(code));
  });

  it('maps the letters a reader substitutes for digits', () => {
    // Someone reading "0" off paper types "O"; "1" becomes "I" or "l".
    expect(normaliseRecoveryCode('RXL-O0000-11111-22222-33333')).toBe('00000111112222233333');
    expect(normaliseRecoveryCode('RXL-I1111-L1111-22222-33333')).toBe('11111111112222233333');
  });

  it('rejects the wrong length', () => {
    expect(normaliseRecoveryCode('RXL-2W3K9')).toBeUndefined();
    expect(normaliseRecoveryCode(`${code}-EXTRA`)).toBeUndefined();
  });

  it('rejects characters outside the alphabet', () => {
    expect(normaliseRecoveryCode('RXL-2W3K9-8HT4M-QRZ57-PN6V!')).toBeUndefined();
  });

  it('rejects nothing at all', () => {
    expect(normaliseRecoveryCode('')).toBeUndefined();
    expect(normaliseRecoveryCode('RXL')).toBeUndefined();
  });
});

describe('the canonical form', () => {
  it('is what gets hashed, so every accepted spelling hashes the same', () => {
    const printed = formatRecoveryCode(bytes(11));
    const spellings = [printed, printed.toLowerCase(), printed.replace(/-/g, ''), printed.replace(/^RXL-/, '')];
    const canonical = spellings.map((s) => canonicalRecoveryCode(normaliseRecoveryCode(s)!));
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe(printed);
  });

  it('round-trips anything the formatter produces', () => {
    for (let i = 0; i < 256; i += 13) {
      const code = formatRecoveryCode(bytes(i));
      expect(canonicalRecoveryCode(normaliseRecoveryCode(code)!)).toBe(code);
    }
  });
});
