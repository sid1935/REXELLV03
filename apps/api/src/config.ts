/**
 * Configuration, read once and validated before anything opens a port.
 *
 * The rule this file exists to enforce: **a production process refuses to start
 * misconfigured rather than starting insecure.** Before it, missing environment
 * meant defaults — open signup, no throttling, an ephemeral key — and each
 * default was individually reasonable in development and collectively a
 * production incident. Every unsafe posture is now something you have to ask
 * for by name.
 *
 * `REXELL_ENV` picks the posture:
 *
 *   development  every convenience default, warnings only. What `npm start` sets.
 *   production   nothing is assumed; anything unsafe must be requested explicitly.
 */

export type Env = 'development' | 'production';

export interface ApiConfig {
  env: Env;
  port: number;
  host: string;
  dbPath: string;
  vaultUrl: string;
  vaultToken: string | undefined;
  trustProxy: boolean;
  signup: { mode: 'open' } | { mode: 'invite'; token: string };
  onsale: { drainPerSecond: number; secret: Buffer; lottery: boolean };
  chain: { kind: 'simulated' };
  chainDrainMs: number;
  rateLimit: {
    overall: { ratePerSecond: number; burst: number };
    creates: { ratePerSecond: number; burst: number };
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to start. ${problems.length} configuration problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const bool = (raw: string | undefined): boolean => raw === 'true' || raw === '1';

function number(raw: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  // `Number('')` is 0 and `Number('abc')` is NaN. A port of 0 or a drain rate of
  // NaN is the kind of thing that surfaces as a mystery an hour after deploy.
  if (!Number.isFinite(n) || n <= 0) {
    problems.push(`${name} must be a positive number; got ${JSON.stringify(raw)}.`);
    return fallback;
  }
  return n;
}

function base64Key(raw: string | undefined, name: string, problems: string[]): Buffer | undefined {
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'base64');
  // Buffer.from is famously forgiving: it decodes garbage to something short
  // rather than throwing, so a truncated secret becomes a weak secret silently.
  if (buf.length < 32) {
    problems.push(`${name} must be at least 32 bytes of base64; decoded to ${buf.length}.`);
    return undefined;
  }
  return buf;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const problems: string[] = [];
  const raw = source['REXELL_ENV'] ?? 'development';
  if (raw !== 'development' && raw !== 'production') {
    problems.push(`REXELL_ENV must be 'development' or 'production'; got ${JSON.stringify(raw)}.`);
  }
  const env: Env = raw === 'production' ? 'production' : 'development';
  const production = env === 'production';

  // ─── signup ────────────────────────────────────────────────────────────
  // The finding that started this file: unauthenticated POST /v1/organizers
  // handed anybody a live key with events:write and settlement:read.
  const inviteToken = source['SIGNUP_INVITE_TOKEN'];
  const wantsOpen = bool(source['SIGNUP_OPEN']);
  let signup: ApiConfig['signup'];
  if (inviteToken) {
    if (inviteToken.length < 24) {
      problems.push('SIGNUP_INVITE_TOKEN must be at least 24 characters.');
    }
    signup = { mode: 'invite', token: inviteToken };
  } else if (wantsOpen) {
    signup = { mode: 'open' };
  } else if (production) {
    problems.push(
      'Set SIGNUP_INVITE_TOKEN, or SIGNUP_OPEN=true to genuinely let strangers create organizers.',
    );
    signup = { mode: 'invite', token: 'unreachable' };
  } else {
    signup = { mode: 'open' };
  }

  // ─── secrets ───────────────────────────────────────────────────────────
  const onsaleSecret = base64Key(source['ONSALE_SECRET'], 'ONSALE_SECRET', problems);
  if (production && !onsaleSecret) {
    // Queue tokens are HMACed with this. Regenerated on restart, every person
    // already in the waiting room is silently ejected — during an onsale.
    problems.push('ONSALE_SECRET is required in production (32+ bytes, base64).');
  }

  const vaultToken = source['VAULT_TOKEN'];
  if (production && !vaultToken) {
    problems.push('VAULT_TOKEN is required in production; it is what authenticates the API to the vault.');
  }

  const vaultUrl = source['VAULT_URL'] ?? 'http://127.0.0.1:8090';
  if (production && vaultUrl.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(vaultUrl)) {
    // Biometric templates cross this hop.
    problems.push(`VAULT_URL is plaintext HTTP to a non-loopback host (${vaultUrl}). Use https:// or a loopback/unix hop.`);
  }

  // ─── proxy ─────────────────────────────────────────────────────────────
  const trustProxy = bool(source['TRUST_PROXY']);
  if (production && !trustProxy) {
    // Not fatal — a directly-exposed process is a legitimate posture — but the
    // rate limiter keys on client address, and behind an untrusted proxy that
    // address is the proxy's, so the entire internet shares one bucket.
    console.warn(
      '[config] TRUST_PROXY is not set. If a load balancer terminates TLS in front of this ' +
        'process, every client shares one rate-limit bucket. Set TRUST_PROXY=true only if that ' +
        'proxy overwrites x-forwarded-for.',
    );
  }

  const config: ApiConfig = {
    env,
    port: number(source['PORT'], 8080, 'PORT', problems),
    // Loopback by default in production: the intended shape is a proxy in front,
    // and a process that binds 0.0.0.0 on a box with a loose firewall is exposed
    // without anybody deciding to expose it.
    host: source['HOST'] ?? (production ? '127.0.0.1' : '0.0.0.0'),
    dbPath: source['REXELL_DB'] ?? 'rexell.sqlite',
    vaultUrl,
    vaultToken,
    trustProxy,
    signup,
    onsale: {
      drainPerSecond: number(source['ONSALE_DRAIN_PER_SECOND'], 200, 'ONSALE_DRAIN_PER_SECOND', problems),
      secret: onsaleSecret ?? Buffer.alloc(0),
      lottery: source['ONSALE_LOTTERY'] !== 'false',
    },
    // One kind, for now. `FakeChain` is a simulator and is labelled as one
    // everywhere it is reported, because an operator reading "chain: ok" on a
    // dashboard should not have to know which implementation answered.
    chain: { kind: 'simulated' },
    chainDrainMs: number(source['CHAIN_DRAIN_MS'], 5_000, 'CHAIN_DRAIN_MS', problems),
    /*
     * Throttling is always wired, so the code path is exercised, but the
     * numbers differ by posture.
     *
     * Development is deliberately generous. `npm run seed:demo` makes several
     * thousand calls from one address in about a minute — sixty enrolments,
     * four hundred purchases, twenty resales — and production limits reduce it
     * to an empty database. A demo seed being throttled teaches nobody
     * anything about scalping.
     */
    rateLimit: production
      ? {
          // ~8 rps sustained with a 120 burst. A fan clicking through the app
          // makes single-digit requests a minute; this only bites automation.
          overall: {
            ratePerSecond: number(source['RATE_OVERALL_RPS'], 8, 'RATE_OVERALL_RPS', problems),
            burst: number(source['RATE_OVERALL_BURST'], 120, 'RATE_OVERALL_BURST', problems),
          },
          // Ten organizer signups an hour from one address, no burst beyond
          // five. A real promoter signs up once.
          creates: {
            ratePerSecond: number(source['RATE_CREATE_RPS'], 10 / 3600, 'RATE_CREATE_RPS', problems),
            burst: number(source['RATE_CREATE_BURST'], 5, 'RATE_CREATE_BURST', problems),
          },
        }
      : {
          overall: {
            ratePerSecond: number(source['RATE_OVERALL_RPS'], 2_000, 'RATE_OVERALL_RPS', problems),
            burst: number(source['RATE_OVERALL_BURST'], 10_000, 'RATE_OVERALL_BURST', problems),
          },
          creates: {
            ratePerSecond: number(source['RATE_CREATE_RPS'], 50, 'RATE_CREATE_RPS', problems),
            burst: number(source['RATE_CREATE_BURST'], 200, 'RATE_CREATE_BURST', problems),
          },
        },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** What is safe to print at boot. Secrets are reported as present or absent. */
export function describe(config: ApiConfig): Record<string, unknown> {
  return {
    env: config.env,
    listen: `${config.host}:${config.port}`,
    db: config.dbPath,
    vault: config.vaultUrl,
    vaultToken: config.vaultToken ? 'set' : 'absent',
    signup: config.signup.mode,
    trustProxy: config.trustProxy,
    chain: config.chain.kind,
    rateLimit: `${config.rateLimit.overall.ratePerSecond}/s burst ${config.rateLimit.overall.burst}`,
  };
}
