# Deploying ReXell

One host, Caddy in front for TLS, and five processes behind it. There are two
ways to run those five, and they are equivalent in behaviour.

```bash
cp .env.example .env
npm run gen-secrets >> .env   # then edit the hostnames
docker compose up -d --build
```

The API validates its configuration before it opens a port. If something is
missing it exits `78` and prints every problem at once, rather than starting in
a weaker posture than you intended.

> **Honest status of the two paths.** The five processes have been run directly
> and exercised end to end — enrolment, purchase, resale, settlement, gate, and
> a backup restored into a clean instance. The **container images have never
> been built**, because no Docker daemon was available where this was written.
> The Dockerfile and compose file are careful but unverified; expect the first
> `docker compose up --build` to need a fix or two. If you want the path with
> the least unknown in it, use systemd below.

---

## Which path

| | Docker Compose | systemd |
|---|---|---|
| Setup | one command | copy five units |
| Isolation | containers, internal network for the vault | systemd sandboxing, loopback binds |
| Verified here | **no — never built** | yes, as processes |

Both put Caddy in front, both bind everything else to loopback, and both use
the same environment file.

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

## Where to host the API, including for free

Three things decide whether a host can run this at all:

1. **A disk that survives a restart.** SQLite is a file. A host with an
   ephemeral filesystem loses every ticket, every enrolment and every
   settlement on each deploy — silently, because the app recreates an empty
   schema and looks healthy.
2. **A process that is not put to sleep.** The chain outbox and the waiting
   room drain on timers. A host that idles the process stops both.
3. **Ports 80 and 443.** Caddy needs them to obtain a certificate, and the
   camera needs the certificate.

The whole runtime is pure JavaScript plus built-in `node:sqlite` — no native
modules — so **ARM hosts work fine**, which is what makes the best free tier
viable.

### Free tiers that actually work

| Host | What you get | Catch |
|---|---|---|
| **Oracle Cloud Always Free** | 4 ARM cores, 24 GB RAM, 200 GB disk, permanent | Card required for identity; ARM capacity is scarce in popular regions; idle accounts can be reclaimed |
| **Google Cloud Free Tier** | 1 `e2-micro`, 1 GB RAM, 30 GB disk, permanent | Only `us-west1`, `us-central1`, `us-east1`. 1 GB is tight but sufficient |
| **AWS / Azure free tier** | 1 small instance | **12 months only**, then billed |

Oracle's free tier is genuinely oversized for this — 24 GB of RAM against an
app that idles near 300 MB. Take it if you can get through signup.

### Free tiers that will quietly destroy your data

Do not use these for the API, whatever their marketing says:

- **Render / Railway / Fly free plans** — ephemeral disks, or sleep on idle.
  Your database is gone on the next deploy and the outbox stops draining.
- **Vercel / Netlify / Cloudflare Pages** — no long-running process at all.
  The surfaces belong here; the API cannot.
- **Anything "serverless"** — a single-writer SQLite file and a pool of
  short-lived function instances are incompatible by construction.

The failure mode is the dangerous part: none of these error. The app boots,
migrates an empty schema, and reports healthy.

### A free hostname, if you do not own a domain

Caddy needs a name that resolves to the host. [DuckDNS](https://www.duckdns.org)
gives one free, and Let's Encrypt issues for it normally:

```
api-yourname.duckdns.org      → the VPS public IP
```

Point `PUBLIC_API_HOST` at it and set `REXELL_API=https://api-yourname.duckdns.org`
on the Netlify sites. A real domain is a few dollars a year and looks like a
business; a DuckDNS name is fine for a pilot and costs nothing.

---

## Putting the browser surfaces on Netlify

The three surfaces are static files, so they can be hosted anywhere. The API
and the vault cannot: they are long-running processes with a SQLite database
that has one writer and background timers draining the chain outbox and the
waiting room. Netlify has no persistent filesystem and no long-running process.

So this is a split deployment: **surfaces on Netlify, API on a host that keeps
a process alive.** The API still needs the systemd or Compose setup above.

### One repository, three sites

Each Netlify site points at this repository and differs only in two
environment variables, under *Site configuration → Environment variables*:

| Site | `NETLIFY_SURFACE` | Also needs |
|---|---|---|
| yourdomain.com | `site` | `REXELL_FAN`, `REXELL_CONSOLE` |
| tickets.yourdomain.com | `fan` | — |
| organizers.yourdomain.com | `console` | — |
| gate.yourdomain.com | `scanner` | — |

Every site needs `REXELL_API` set to the public HTTPS origin of your API.

The **site** surface is the marketing front door, imported from the previous
deployment. Its "Join as Fan" and "Join as Organizer" buttons need somewhere
to go, so it additionally needs `REXELL_FAN` and `REXELL_CONSOLE` — the public
origins of those two sites. The build refuses without them, because a front
door whose buttons do nothing deploys looking perfect.

Build settings come from `netlify.toml` and need no changes: the command is
`npm run build:netlify` and the publish directory is `dist`.

`REXELL_API` is the **public HTTPS origin of your API** — never a localhost
address. The build refuses to run without it, and refuses a plaintext one,
because a surface built with either deploys and renders perfectly while every
call quietly goes nowhere.

### What the build does that the Node server did at runtime

`packages/ui/static-server.js` generates two things per request that a static
host cannot. `scripts/build-netlify.js` writes them into `dist/` instead:

- **`config.js`** — carries the API origin, so no page reads it from a query
  string. The surfaces used to accept `?api=`, which meant a link could point
  the fan app, including the enrolment step where a face is captured, at a
  server chosen by whoever wrote the link.
- **`_headers`** — the security headers. The CSP has to name the API origin in
  `connect-src`, and `netlify.toml` cannot interpolate an environment variable,
  so it is generated rather than declared. This is why `netlify.toml` sets no
  headers of its own: two sources of truth, one incomplete, is worse than one.

### Before you point DNS at it

The API's CORS is `*`, so the surfaces can call it cross-origin from day one.
What does need saying: the fan app and the scanner both ask for a camera, and
a browser only grants that over HTTPS. Netlify provides it; your API host must
too, or the fetch from an HTTPS page to a plaintext API is blocked as mixed
content.

### Is this worth it over serving them from the same host?

Only if you want Netlify's deploy workflow. Caddy already serves these three
surfaces on the API host with the same headers and no extra moving parts. The
split is a preference, not an improvement.

---

## The systemd path, step by step

Debian or Ubuntu, one host, from nothing.

**1. Node 24 and Caddy.** `node:sqlite` is used unflagged, so 22 is the floor
and 24 is what this is tested on.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs caddy git
```

**2. A user that owns nothing else.**

```bash
sudo useradd --system --home /srv/rexell --shell /usr/sbin/nologin rexell
sudo mkdir -p /srv/rexell /var/lib/rexell /etc/rexell
sudo chown rexell:rexell /srv/rexell /var/lib/rexell
```

**3. The code, built.**

```bash
sudo -u rexell git clone <your-remote> /srv/rexell
cd /srv/rexell
sudo -u rexell npm ci
sudo -u rexell npm run build
sudo -u rexell npm prune --omit=dev    # optional; drops hardhat and friends
```

**4. The environment file.** This holds every secret, so it is the one file on
the host that must not be world-readable.

```bash
npm run gen-secrets | sudo tee /etc/rexell/rexell.env
sudo chown root:rexell /etc/rexell/rexell.env
sudo chmod 640 /etc/rexell/rexell.env
sudo nano /etc/rexell/rexell.env      # add the four hostnames and REXELL_API
```

It needs the generated secrets plus:

```
PUBLIC_FAN_HOST=tickets.example.com
PUBLIC_CONSOLE_HOST=organizers.example.com
PUBLIC_SCANNER_HOST=gate.example.com
PUBLIC_API_HOST=api.example.com
REXELL_API=https://api.example.com
```

`REXELL_API` is what the browser is told to call, so it is the public HTTPS
address of the API — never this host's loopback.

**5. The services.**

```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rexell-vault rexell-api rexell-fan rexell-console rexell-scanner
systemctl status 'rexell-*' --no-pager
```

The units set `RestartPreventExitStatus=78`, so a process that refused to start
because of bad configuration stays down with its message readable in
`journalctl -u rexell-api` instead of looping and burying it.

**6. TLS.** All four hostnames must already resolve to this host, or issuance
fails.

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy      # add the four PUBLIC_*_HOST vars as Environment=
sudo systemctl restart caddy
```

**7. Check it.**

```bash
curl -fsS https://api.example.com/health
```

Then open the console hostname, create the first organizer with the invite
token, and walk `docs/DEMO.md`.

**8. Backups on a schedule.** A daily timer, and copy the results off the host.

```bash
sudo tee /etc/cron.daily/rexell-backup >/dev/null <<'SH'
#!/bin/sh
cd /srv/rexell && \
REXELL_DB=/var/lib/rexell/rexell.sqlite \
VAULT_DB=/var/lib/rexell/vault.sqlite \
/usr/bin/node scripts/backup.js /var/backups/rexell
SH
sudo chmod +x /etc/cron.daily/rexell-backup
```

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

**There is no liveness detection.** The matcher itself is real — one network,
shared by the fan app and the gate, with thresholds measured against its own
output — but nothing can tell a face from a photograph of a face, so a printed
picture enrols and is admitted. That is the blocker on a real door.

**The thresholds are measured on five people.** Enough to show the two
distributions separate; not enough to say anything about false accepts across an
event-sized gallery. Re-measure on the real population and cameras before an
event.

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
