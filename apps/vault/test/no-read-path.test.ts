import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildVault } from '../src/app.js';
import { face, capture, enrol } from './helpers.js';

/**
 * The M2 exit criterion, as an executable assertion.
 *
 * "No application service can retrieve a template." Three ways of checking it,
 * because a comment saying so is worth nothing and a code review only catches
 * the route somebody adds while the reviewer is looking.
 */
describe('the vault has no read path', () => {
  it('exposes no GET route that could return a template', async () => {
    const vault = buildVault({ masterKey: randomBytes(32), receiptKey: randomBytes(32) });
    await vault.server.ready();

    // Enumerate what the router actually serves, rather than trusting the source.
    const routes = vault.server
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const readShaped = routes.filter((r) => /GET/.test(r) && /template|vector|embedding|descriptor|export|dump/i.test(r));
    expect(readShaped, `unexpected read-shaped routes:\n${readShaped.join('\n')}`).toEqual([]);

    await vault.server.close();
    vault.store.close();
  });

  it('never returns template bytes from any endpoint, even to an authorised caller', async () => {
    const vault = buildVault({ masterKey: randomBytes(32), receiptKey: randomBytes(32), now: () => 1_000 });
    await vault.server.ready();

    const alice = face(1);
    const enrolled = await enrol(vault, 'idn_alice', 'evt_1', alice);
    expect(enrolled.statusCode).toBe(201);

    const bodies: string[] = [];
    bodies.push(enrolled.body);
    bodies.push((await vault.server.inject({ method: 'POST', url: '/v1/verify', payload: { identityId: 'idn_alice', scope: 'evt_1', probe: [...capture(alice)] } })).body);
    bodies.push((await vault.server.inject({ method: 'POST', url: '/v1/identify', payload: { scope: 'evt_1', probe: [...capture(alice)] } })).body);
    bodies.push((await vault.server.inject({ method: 'GET', url: '/v1/scopes/evt_1/flags' })).body);
    bodies.push((await vault.server.inject({ method: 'POST', url: '/v1/forget', payload: { identityId: 'idn_alice' } })).body);

    for (const body of bodies) {
      // No field carrying vector data under any of the obvious names.
      expect(body).not.toMatch(/"(vector|template|embedding|descriptor|ciphertext|probe|wrappedKey)"\s*:/);
      // And no accidental long numeric array, which is what a leak would look
      // like even if somebody named the field innocuously.
      const arrays = body.match(/\[[-0-9.eE,\s]{200,}\]/g) ?? [];
      expect(arrays, `numeric array leaked in: ${body.slice(0, 200)}`).toEqual([]);
    }

    await vault.server.close();
    vault.store.close();
  });

  it('does not import the application database package', async () => {
    // A dependency edge from the vault to `@rexell/db` would let a future change
    // join a template to a name. There must be no such edge to begin with.
    const pkg = await import('../package.json', { with: { type: 'json' } });
    const deps = Object.keys((pkg.default as { dependencies?: Record<string, string> }).dependencies ?? {});
    expect(deps).not.toContain('@rexell/db');
    expect(deps).not.toContain('@rexell/domain');
  });
});
