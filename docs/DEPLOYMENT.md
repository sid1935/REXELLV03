# Deploying ReXell

One host, Docker Compose, Caddy in front for TLS.

```bash
cp .env.example .env      # fill it in
docker compose up -d --build
```

The API validates its configuration before it opens a port. If something is
missing it exits `78` and prints every problem at once, rather than starting in
a weaker posture than you intended.

---

## Why one host

`node:sqlite` is a synchronous, single-process library. There is one writer, and
two API containers against the same volume will corrupt each other. The rate
limiter is per-process for the same reason — a second replica would silently
double every limit.

This is a real ceiling, and it is roughly a few hundred requests a second and
one venue at a time. Going past it means replacing the storage layer (Postgres),
moving the limiter to a shared counter, and moving the waiting room out of
process. None of that is written. Do not scale this by adding replicas.

---

## What you must set

Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | Why it matters |
|---|---|
| `VAULT_MASTER_KEY` | Encrypts every biometric template. Lose it and everybody re-enrols; leak it and the templates are readable. There is no re-encryption routine, so this cannot be rotated casually. |
| `VAULT_RECEIPT_KEY` | HMACs deletion receipts. A person who withdraws consent gets one, and it has to stay verifiable. |
| `VAULT_TOKEN` | Authenticates the API to the vault. Stands in for mTLS. |
| `ONSALE_SECRET` | HMACs waiting-room tokens. Regenerate it during an onsale and everybody queued is ejected. |
| `SIGNUP_INVITE_TOKEN` **or** `SIGNUP_OPEN` | See below. Exactly one, and the API will not start without one of them. |
| `PUBLIC_*_HOST` | Hostnames Caddy obtains certificates for. They must already resolve here. |
| `PUBLIC_API_URL` | Baked into `/config.js` so no page takes its API origin from a query string. |

`VAULT_MASTER_KEY` belongs somewhere that is not this host. A database backup
without it is a file of unreadable ciphertext.

### Signup is the one to think about

`POST /v1/organizers` is unauthenticated by design — an organizer reaching a
working API key without anybody at ReXell touching anything is the whole point
of the self-serve milestone, and it is what makes the demo land. It also means
that on a public deployment, **anybody who can reach the port can mint a key
with `events:write` and `settlement:read`**.

So production requires you to choose:

- `SIGNUP_INVITE_TOKEN=<24+ chars>` — signup and event creation need
  `x-signup-token`. This is the right answer for a pilot.
- `SIGNUP_OPEN=true` — genuinely open. The server logs a warning at every boot.

Development (`npm start`) sets `SIGNUP_OPEN=true` for you, because the demo
needs it.

---

## TLS is not optional

Both the fan app and the gate scanner need a camera, and `getUserMedia` is
refused on plain HTTP anywhere except `localhost`. Without TLS, enrolment and
the gate do not work at all on a real device. Caddy handles issuance and renewal
on its own; that is why it is in the compose file.

`TRUST_PROXY=true` is set on the API because Caddy overwrites `x-forwarded-for`.
If you put something else in front, confirm it does the same — with
`TRUST_PROXY=true` and a proxy that passes the client's header through, a caller
picks its own rate-limit bucket with one header. With it unset behind any proxy,
the whole internet shares one bucket.

---

## What is running

| Service | Port | Exposed |
|---|---|---|
| `caddy` | 80, 443 | yes — the only thing bound to the host |
| `api` | 8080 | via Caddy |
| `fan` / `console` / `scanner` | 8120 / 8110 / 8100 | via Caddy |
| `vault` | 8090 | **no** — internal network, reachable only by the API |

The vault is on a Docker network marked `internal`, so it has no route off the
host even if something else on the box is compromised.

---

## Backups

The API container can only see its own volume, and the vault's database is on a
separate one, so a full backup is two commands:

```bash
docker compose exec api     node scripts/backup.js /data/backups
docker compose exec vault   node scripts/backup.js /data/backups
```

Each writes a timestamped directory and skips the database it cannot see. On a
host checkout, point it at both:

```bash
REXELL_DB=/path/rexell.sqlite VAULT_DB=/path/vault.sqlite npm run backup -- /var/backups/rexell
```

The script is plain JavaScript rather than TypeScript because the runtime image
prunes dev dependencies, `tsx` among them — a backup command that only runs on
a developer's laptop is not a backup command.

Copy the timestamped directories off the host on a schedule. A backup sitting
on the volume you are protecting is not a backup.

`VACUUM INTO`, not a file copy: SQLite in WAL mode is several files, and copying
the main database mid-write produces something that looks fine and restores
corrupt. The script takes a read lock, so the API keeps serving while it runs,
and exits non-zero on failure so a cron job that ignores stdout still reports it.

Restore by stopping the stack, putting the file back at `REXELL_DB`, and
starting. Migrations run on startup and are idempotent.

**Test the restore before you need it**, including that you can still read
`VAULT_MASTER_KEY` from wherever you put it.

---

## Health and rollout

`GET /health` returns 503 when the process is running against a schema it does
not match, which is what you want a load balancer to see during a partial
rollout. It is exempt from rate limiting — a throttled probe reads as an outage.

Migrations run automatically at startup, in one transaction each, and are
append-only. They are safe to re-run. They are *not* safe to run from two
processes at once, which is another reason for one host.

---

## What this deployment does not do

Stated plainly, because they are visible from the outside and someone will ask.

**Nothing is on a chain.** `FakeChain` is the only `ChainClient` implementation
that exists. The Solidity in `packages/contracts` is real and has 42 passing
tests, but no adapter connects the API to a deployed contract, and nothing
deploys one. Settlement reconciliation, the mint outbox and `/v1/chain/*` all
work against the simulator. It is reported as `simulated`, never as `ok`.

**The face matcher recognises nobody.** Both the fan app and the scanner ship a
placeholder that folds pixels into a vector, and there is no liveness detection
— a printed photo passes. A licensed SDK replaces one function on each side.

**Gate latency is unmeasured on a phone.** The decision path is 8.3 ms against a
12,000-credential gallery, which leaves about 420 ms for camera and embedding
inside the 800 ms budget. That is an argument, not a measurement.

**No shared rate limiting, no horizontal scaling, no automated restore test.**

Deploying this as a pilot for invited organizers is reasonable. Deploying it as
a public ticketing platform is not, and the gap is the three items above rather
than anything in this document.

---

## Local development

Unchanged, and deliberately unhardened:

```bash
npm start          # vault, API, console, fan — open signup, ephemeral keys
npm run seed:demo  # six events, sixty fans
npm run scanner    # the gate
```

`npm start` sets `REXELL_ENV=development`, which is what permits the ephemeral
vault keys and open signup. Nothing in the development path can be reached by
setting `REXELL_ENV=production` and forgetting a variable — that combination
refuses to start.
