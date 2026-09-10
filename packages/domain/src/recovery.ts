/**
 * Recovery codes.
 *
 * A ReXell ID is created on a device and lives there. Without something like
 * this, losing the phone loses the tickets — and the stopgap it replaces was
 * worse: the fan app briefly let somebody restore an identity by pasting the
 * raw identity id, which is not a secret. That id travels in URL paths, sits
 * in server logs, and is visible to any organizer whose event you attend.
 * Anyone who saw one could list that person's tickets for resale.
 *
 * So: a real secret, generated once, shown once, stored only as a hash.
 *
 * Deliberately NOT a password. There is nothing to remember and nothing to
 * reuse across sites, which removes the whole category of credential stuffing.
 * Deliberately not a phone number either — that would mean collecting a second
 * piece of personal data, and an SMS provider, to solve a problem a printed
 * line of text solves.
 */

/**
 * Crockford base32, which omits I, L, O and U.
 *
 * The first three because they are indistinguishable from 1 and 0 in most
 * faces, and U because excluding it keeps the alphabet from spelling things
 * people would rather not read out to support.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const GROUPS = 4;
const GROUP_LENGTH = 5;

/** 20 characters of a 32-symbol alphabet: 100 bits. */
export const RECOVERY_CODE_BITS = GROUPS * GROUP_LENGTH * 5;

export const RECOVERY_PREFIX = 'RXL';

/**
 * Format random bytes as a grouped, human-transcribable code.
 *
 * Grouped because this gets written on paper and read back over a phone, and
 * an unbroken run of twenty characters is where transcription errors live.
 */
export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length < GROUPS * GROUP_LENGTH) {
    throw new Error(`Need at least ${GROUPS * GROUP_LENGTH} bytes to build a recovery code.`);
  }
  const symbols = Array.from({ length: GROUPS * GROUP_LENGTH }, (_, i) => ALPHABET[bytes[i]! % ALPHABET.length]).join('');
  const groups = Array.from({ length: GROUPS }, (_, g) => symbols.slice(g * GROUP_LENGTH, (g + 1) * GROUP_LENGTH));
  return [RECOVERY_PREFIX, ...groups].join('-');
}

/**
 * Reduce what somebody typed to what we compare.
 *
 * Everything a person plausibly does to a code between reading it off paper
 * and typing it in is undone here: lowercase, spaces instead of hyphens, no
 * hyphens at all, the prefix omitted, and the four characters Crockford maps
 * back onto digits. Rejecting a correct code because it was typed in lower
 * case would be a support burden invented for no reason.
 */
export function normaliseRecoveryCode(input: string): string | undefined {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/^RXL/, '')
    // Crockford's substitutions, in the direction a reader gets them wrong.
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (cleaned.length !== GROUPS * GROUP_LENGTH) return undefined;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return undefined;
  }
  return cleaned;
}

/** The canonical string that gets hashed. Never the raw user input. */
export function canonicalRecoveryCode(normalised: string): string {
  const groups = Array.from({ length: GROUPS }, (_, g) => normalised.slice(g * GROUP_LENGTH, (g + 1) * GROUP_LENGTH));
  return [RECOVERY_PREFIX, ...groups].join('-');
}
