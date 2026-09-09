import { randomBytes } from 'node:crypto';
import { buildVault } from './app.js';

/**
 * Keys come from the environment, which stands in for a KMS/HSM fetch. A vault
 * that generates its own key on boot forgets every template on restart — fine
 * for tests, fatal in production, so this warns loudly.
 */
const fromEnv = (name: string): Buffer | undefined => {
  const raw = process.env[name];
  return raw ? Buffer.from(raw, 'base64') : undefined;
};

const masterKey = fromEnv('VAULT_MASTER_KEY');
const receiptKey = fromEnv('VAULT_RECEIPT_KEY');
if (!masterKey || !receiptKey) {
  console.warn('[vault] VAULT_MASTER_KEY / VAULT_RECEIPT_KEY not set — generating ephemeral keys.');
  console.warn('[vault] Every enrolled template becomes unreadable when this process exits.');
}

const { server } = buildVault({
  location: process.env['VAULT_DB'] ?? 'vault.sqlite',
  masterKey: masterKey ?? randomBytes(32),
  receiptKey: receiptKey ?? randomBytes(32),
  ...(process.env['VAULT_TOKEN'] ? { serviceToken: process.env['VAULT_TOKEN'] } : {}),
  logger: true,
});

const port = Number(process.env['VAULT_PORT'] ?? 8090);
server.listen({ port, host: '127.0.0.1' }).catch((err: unknown) => {
  server.log.error(err);
  process.exit(1);
});
