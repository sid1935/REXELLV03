/**
 * Bring the whole system up.
 *
 *   npm start
 *
 * Four processes: the vault, the API, the organizer console and the fan app.
 * One command, because a demo that begins "open four terminals" is a demo
 * nobody gives twice.
 *
 * The vault gets a stable key from the environment or an ephemeral one, and
 * says which — an ephemeral key means every enrolled template becomes
 * unreadable when this exits, which is correct for a demo and fatal anywhere
 * else.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const b64 = () => randomBytes(32).toString('base64');

const VAULT_TOKEN = process.env['VAULT_TOKEN'] ?? `dev_${randomBytes(12).toString('hex')}`;
const ephemeral = !process.env['VAULT_MASTER_KEY'];

const shared = {
  ...process.env,
  VAULT_TOKEN,
  VAULT_MASTER_KEY: process.env['VAULT_MASTER_KEY'] ?? b64(),
  VAULT_RECEIPT_KEY: process.env['VAULT_RECEIPT_KEY'] ?? b64(),
  // Development posture, stated rather than defaulted. In production every one
  // of these is either required or refused — see apps/api/src/config.ts.
  REXELL_ENV: process.env['REXELL_ENV'] ?? 'development',
  // Open signup is what makes the demo's "the organizer signed themselves up"
  // step work. It is the single most dangerous thing to leak into production,
  // so production requires it to be asked for by name.
  SIGNUP_OPEN: process.env['SIGNUP_OPEN'] ?? 'true',
};

interface Service {
  readonly name: string;
  readonly script: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly colour: string;
}

const SERVICES: readonly Service[] = [
  { name: 'vault  ', script: 'apps/vault/dist/server.js', colour: '[35m', env: { VAULT_PORT: '8090', VAULT_DB: '.dev-vault.sqlite' } },
  { name: 'api    ', script: 'apps/api/dist/server.js', colour: '[36m', env: { PORT: '8080', REXELL_DB: '.dev.sqlite', VAULT_URL: 'http://127.0.0.1:8090' } },
  { name: 'console', script: 'apps/console/serve.js', colour: '[32m', env: { CONSOLE_PORT: '8110' } },
  { name: 'fan    ', script: 'apps/fan/serve.js', colour: '[33m', env: { FAN_PORT: '8120' } },
  { name: 'site   ', script: 'apps/site/serve.js', colour: '[34m', env: { SITE_PORT: '8140' } },
];

const RESET = '[0m';
const DIM = '[2m';
const children: ChildProcess[] = [];

for (const service of SERVICES) {
  const child = spawn(process.execPath, [service.script], {
    env: { ...shared, ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  // Prefix every line so four interleaved logs stay readable.
  const prefix = `${service.colour}${service.name}${RESET} ${DIM}│${RESET} `;
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(prefix + line);
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`${prefix}exited with ${code}`);
  });
}

setTimeout(() => {
  console.log(`
  ${'[1m'}ReXell${RESET} is up.

    ${'[33m'}Fan app${RESET}            http://127.0.0.1:8120
    ${'[32m'}Organizer console${RESET}  http://127.0.0.1:8110
    ${'[36m'}API${RESET}                http://127.0.0.1:8080
    ${'[35m'}Vault${RESET}              http://127.0.0.1:8090

  ${DIM}Gate scanner: npm run scanner${RESET}
  ${ephemeral ? `${DIM}Vault keys are ephemeral — enrolled templates die with this process.${RESET}` : ''}
`);
}, 1_400);

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
