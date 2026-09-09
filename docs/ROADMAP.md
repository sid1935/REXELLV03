# ReXell — Development Plan

Version 1.0 · 09 Sep 2026

This plan builds the system described in `docs/architecture.html` in the order that
retires the most risk per week of work. It is deliberately not ordered by what is
most fun to build.

---

## Guiding rules

1. **The gate is the product.** Every milestone is judged by whether it moves us
   closer to a fan walking up to a camera and walking in. Features that do not
   serve that are deferred.
2. **Pure logic first, I/O second.** All business rules — resale caps, splits,
   purchase limits, entry decisions — live in a dependency-free package with
   exhaustive tests. Databases, HTTP and chains are adapters around it.
3. **Money is integers.** Every amount is in minor units (paise / cents). No
   floating point anywhere in the money path, ever.
4. **The chain is never on the critical path.** Selling a ticket and opening a gate
   must both work with the chain fully down.
5. **No biometric data leaves the vault boundary**, even in prototypes. Prototype
   code that shortcuts this becomes production code that shortcuts this.

---

## Stack decisions (locked for M0–M4)

| Concern | Choice | Why, and what changes it |
|---|---|---|
| Monorepo | npm workspaces | Built into npm 11, zero install. Move to pnpm if install time hurts. |
| Language | TypeScript, strict | Shared types across api / web / gate is the main win. |
| Tests | Vitest | Fast, no config, same runner everywhere. |
| Persistence (dev) | SQLite via Drizzle | No Docker on the dev machine. Schema written Postgres-portable — same Drizzle schema targets Postgres in staging. |
| API | Fastify | Lowest overhead per request; the onsale path is latency-bound. |
| Web | Next.js (App Router) | Organizer console is read-heavy and SSR-friendly. |
| Gate client | PWA first, native Android later | A browser PWA proves the flow. Native is required before a real event for camera control, kiosk mode and offline storage guarantees. |
| Face matching (prototype) | In-browser embedding model | Proves the architecture without a vendor contract. **Replaced by a commercial SDK with certified liveness before any real event** — the prototype matcher has no presentation-attack defence and must never be used at a gate. |
| Contracts | Solidity + Hardhat | Foundry is not installed and Hardhat is npm-installable. |
| Chain | EVM L2 testnet | Chain-agnostic by design; nothing above the Token Service knows which. |

---

## Milestones

### M0 — Domain core `← we are here`

The rules engine, with no dependencies and no I/O.

**Ships**
- Money type in minor units with safe arithmetic
- Event, tier and resale-policy models
- Ticket state machine with explicit legal transitions
- Purchase eligibility: per-identity caps, age gates, enrolment requirement
- Resale validation: on/off, price ceiling, window, cooldown, resale-count cap
- Commission split calculation in basis points, remainder-exact
- Gate manifest model with revocation deltas and sequence numbers
- Entry decision as a pure function

**Exit criteria**
- Every rule in architecture §04, §06 and §07 has a test
- 100% branch coverage on `splits.ts` and `resale.ts` — these two move money
- Zero runtime dependencies in the package

**Why first:** these rules are what the whole product is. Getting them wrong later
means migrating live ticket data. Getting them right now costs a few days.

---

### M1 — Persistence and API

**Ships**
- Drizzle schema for the eleven core entities (architecture §10)
- Repositories and a unit-of-work boundary
- Fastify API: events, tiers, orders, tickets, listings, entry
- Idempotency keys on every write endpoint
- Inventory holds with TTL (in-memory now, Redis later)
- Seed script producing a realistic 12,000-capacity event

**Exit criteria**
- A ticket can be sold and read back through HTTP
- Concurrent purchase of the last ticket produces exactly one sale
- Every endpoint is idempotent under retry

---

### M2 — Identity and enrolment

**Ships**
- `identityId` / `personId` / `templateRef` separation enforced by types
- Vault service as a separate process with no read API — only `match()` and `enrol()`
- Versioned, unbundled consent records with withdrawal
- 1:N dedupe within a bounded scope, producing review flags rather than blocks
- In-browser embedding + liveness challenge (prototype grade)

**Exit criteria**
- No application service can retrieve a template — enforced by an integration test
- Withdrawing consent deletes the template and returns a verifiable receipt
- Enrolling the same face twice on two accounts raises a dedupe flag

---

### M3 — Contracts and issuance

**Ships**
- `TicketNFT` with bound and capped modes, no free-transfer path
- `ResaleController` enforcing ceiling, window, cooldown on chain
- `RoyaltySplitter` with basis-point splits fixed at event creation
- `AccessRegistry` binding `identityId` to a smart account
- Token Service: async batched minting, database as source of truth until confirmed
- Hardhat test suite including adversarial transfer attempts

**Exit criteria**
- A bound ticket cannot be transferred by any caller, proven by test
- A resale above the ceiling reverts
- Splits sum exactly to the sale price with no dust
- Tickets still sell with the chain stopped

---

### M4 — The gate

**Ships**
- Manifest builder: encrypted, event-scoped, TTL-bounded
- Delta sync with sequence numbers and staleness display
- Offline-first scanner PWA with local match and queued signed attestations
- Reconciliation job detecting double-entry after a partition
- Operator fallback flow with audit records

**Exit criteria**
- A scanner with the network physically off admits and denies correctly
- p95 decision latency under 800 ms on a mid-range Android device
- A resale revokes the seller's credential at every lane within 30 seconds online

---

### M5 — Onsale defence

**Ships**
- Edge fair queue with signed admission tokens
- Inline risk scorer, p99 under 50 ms
- Feature store with identical transforms online and offline
- Nightly graph clustering over device, payment and behaviour edges
- Fraud review console

**Exit criteria**
- A simulated 40,000 req/s onsale clears without origin saturation
- A scripted bot buying run is blocked at above 95% while a human control run passes

---

### M6 — Organizer self-serve

**Ships**
- Event creation, tier and resale policy UI
- Live sales, attendance and resale analytics
- Settlement reporting reconciled against on-chain split events
- Self-serve onboarding and API keys

**Exit criteria**
- An event runs end to end with no ReXell staff involved — the margin proof

---

## Sequencing rationale

M2 (identity) comes before M3 (contracts) because the contracts bind to
`identityId`, and getting the identity model wrong makes the contracts wrong.
M4 (gate) comes before M5 (bot defence) because a gate that works is the sales
asset, and bot defence needs the labels that only a working gate produces.

## Not building, on purpose

- Discovery, search, or a consumer marketplace front end — organizers bring the audience
- Dynamic pricing
- An in-house face recognition model
- A mobile wallet or any user-visible crypto surface
- iOS native, until there is a Mac in the loop and a real event that needs it
