import { randomBytes } from 'node:crypto';
import { buildVault } from './app.js';

/**
 * The vault process.
 *
 * Keys come from the environment, which stands in for a KMS/HSM fetch.
 *
 * A vault that generates its own key on boot forgets every enrolled template
 * when it restarts. This used to warn and carry on, which is the wrong shape:
 * the warning scrolls past, enrolments succeed, and the damage is discovered at
 * a gate weeks later when nobody can be matched. It now refuses to start in
 * production, and requires `VAULT_ALLOW_EPHEMERAL=true` to be said out loud
 * anywhere else.
 */

const production = process.env['REXELL_ENV'] === 'production';

const fromEnv = (name: string): Buffer | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'base64');
  // Buffer.from decodes garbage to something short rather than throwing, so a
  // truncated key would otherwise become a weak key in silence.
  if (buf.length < 32) {
    console.error(`[vault] ${name} decoded to ${buf.length} bytes; 32 or more required.`);
    process.exit(78); // EX_CONFIG
  }
  return buf;
};

const masterKey = fromEnv('VAULT_MASTER_KEY');
const receiptKey = fromEnv('VAULT_RECEIPT_KEY');

if (!masterKey || !receiptKey) {
  const allowed = process.env['VAULT_ALLOW_EPHEMERAL'] === 'true' && !production;
  if (!allowed) {
    console.error('\n[vault] VAULT_MASTER_KEY / VAULT_RECEIPT_KEY are not set.');
    console.error('[vault] Generating them per-boot makes every enrolled template unreadable');
    console.error('[vault] after a restart, and that is not recoverable.');
    console.error('\n[vault] Generate a pair:');
    console.error("[vault]   node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    console.error('\n[vault] For a throwaway local run, set VAULT_ALLOW_EPHEMERAL=true.\n');
    process.exit(78); // EX_CONFIG
  }
  console.warn('[vault] Ephemeral keys. Every enrolled template dies with this process.');
}

const serviceToken = process.env['VAULT_TOKEN'];
if (production && !serviceToken) {
  console.error('[vault] VAULT_TOKEN is required in production; it is what separates the API from everybody else.\n');
  process.exit(78);
}

const { server } = buildVault({
  location: process.env['VAULT_DB'] ?? 'vault.sqlite',
  masterKey: masterKey ?? randomBytes(32),
  receiptKey: receiptKey ?? randomBytes(32),
  ...(serviceToken ? { serviceToken } : {}),
  logger: true,
});

const port = Number(process.env['VAULT_PORT'] ?? 8090);
// Loopback, always. Nothing outside this host has business reaching the vault
// directly, and the API is the only thing that ever does.
const host = process.env['VAULT_HOST'] ?? '127.0.0.1';

server.listen({ port, host }).catch((err: unknown) => {
  server.log.error(err);
  process.exit(1);
});
