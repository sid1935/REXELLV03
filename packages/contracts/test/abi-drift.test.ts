/**
 * The API's hand-written ABI must match the compiled contract.
 *
 * `apps/api/src/chain/evm-chain.ts` declares the handful of functions it calls
 * rather than importing `artifacts/`, which is build output and gitignored — a
 * fresh clone would have no ABI at all, and the API would fail to start for a
 * reason that had nothing to do with the API.
 *
 * The cost of that copy is drift, and drift here is quiet. Rename a parameter
 * type, reorder two arguments, change `uint16` to `uint32`, and the encoder
 * produces well-formed calldata that the contract decodes into something else
 * entirely. Nothing throws. The mint just goes to the wrong tier.
 *
 * So the copy is checked against the artifact, which is the thing actually
 * deployed. This test runs in the contracts package because that is where the
 * artifacts are.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROLLER_ABI, FACTORY_ABI, REGISTRY_ABI, TICKET_ABI } from '../../../apps/api/src/chain/evm-chain.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface AbiEntry {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: { name?: string; type: string; indexed?: boolean }[];
  outputs?: { type: string }[];
}

function artifact(contract: string): AbiEntry[] {
  const path = resolve(here, '..', 'artifacts', 'contracts', `${contract}.sol`, `${contract}.json`);
  return JSON.parse(readFileSync(path, 'utf8')).abi as AbiEntry[];
}

/** Types and order, which is all the encoder actually uses. */
const shape = (e: AbiEntry) => ({
  type: e.type,
  name: e.name,
  stateMutability: e.stateMutability,
  inputs: (e.inputs ?? []).map((i) => ({ type: i.type, indexed: i.indexed ?? false })),
  outputs: (e.outputs ?? []).map((o) => o.type),
});

function assertMatches(label: string, declared: readonly unknown[], contract: string) {
  const real = artifact(contract);
  for (const entry of declared as AbiEntry[]) {
    const match = real.find((r) => r.type === entry.type && r.name === entry.name);
    assert.ok(match, `${label}: the contract has no ${entry.type} named ${entry.name}`);
    assert.deepEqual(
      shape(entry),
      shape(match),
      `${label}.${entry.name} does not match the compiled contract — calldata would encode wrongly`,
    );
  }
}

describe('the API ABI matches the contracts', () => {
  it('AccessRegistry', () => assertMatches('REGISTRY_ABI', REGISTRY_ABI, 'AccessRegistry'));
  it('EventFactory', () => assertMatches('FACTORY_ABI', FACTORY_ABI, 'EventFactory'));
  it('TicketNFT', () => assertMatches('TICKET_ABI', TICKET_ABI, 'TicketNFT'));
  it('ResaleController', () => assertMatches('CONTROLLER_ABI', CONTROLLER_ABI, 'ResaleController'));

  it('covers every function the client calls', () => {
    // A guard against the opposite failure: somebody adds a call to the client
    // and forgets to declare it, so the ABI is correct and incomplete.
    const declared = new Set(
      [...REGISTRY_ABI, ...FACTORY_ABI, ...TICKET_ABI, ...CONTROLLER_ABI]
        .filter((e) => e.type === 'function')
        .map((e) => e.name),
    );
    const source = readFileSync(resolve(here, '..', '..', '..', 'apps', 'api', 'src', 'chain', 'evm-chain.ts'), 'utf8');
    for (const [, name] of source.matchAll(/functionName: '([a-zA-Z0-9_]+)'/g)) {
      assert.ok(declared.has(name), `evm-chain.ts calls ${name}() but no ABI here declares it`);
    }
  });
});
