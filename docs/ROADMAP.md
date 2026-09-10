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
| Persistence (dev) | SQLite via built-in `node:sqlite`, hand-written SQL | No Docker and no native build on the dev machine. Drizzle was the plan and was dropped: the interesting concurrency in this system is a handful of conditional UPDATEs whose `changes` count is the correctness guard, and an ORM makes those harder to read, not easier. Schema is Postgres-portable by a mechanical translation documented in `schema.ts`. |
| API | Fastify | Lowest overhead per request; the onsale path is latency-bound. |
| Web | Next.js (App Router) | Organizer console is read-heavy and SSR-friendly. |
| Gate client | PWA first, native Android later | A browser PWA proves the flow. Native is required before a real event for camera control, kiosk mode and offline storage guarantees. |
| Face matching (prototype) | In-browser embedding model | Proves the architecture without a vendor contract. **Replaced by a commercial SDK with certified liveness before any real event** — the prototype matcher has no presentation-attack defence and must never be used at a gate. |
| Contracts | Solidity 0.8.28, Hardhat 3, OpenZeppelin 5, viaIR | Foundry is not installed; Hardhat is npm-installable and fetched solc without trouble. viaIR because TicketNFT's constructor takes four trust-critical addresses plus the tier array and overflows the legacy stack. No EIP-1167 clones: on an L2 a deploy costs a fraction of a cent, which is a good trade for keeping those addresses `immutable`. |
| Chain | EVM L2 testnet | Chain-agnostic by design; nothing above the Token Service knows which. |

---

## Milestones

### M0 — Domain core ✅ done

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

### M1 — Persistence and API ✅ done `103 tests green`

**Ships**
- Schema for the eleven core entities (architecture §10), with the two money/capacity invariants also enforced as CHECK constraints
- Repositories and a transaction boundary
- Fastify API: events, orders, tickets, listings, settlement, manifest, deltas, attestations, reconciliation
- Idempotency keys on every write endpoint
- Inventory holds with TTL (in-memory now, Redis later)
- Seed script producing a realistic 12,000-capacity event

**Exit criteria**
- A ticket can be sold and read back through HTTP
- Concurrent purchase of the last ticket produces exactly one sale
- Every endpoint is idempotent under retry

---

### M2 — Identity and enrolment ✅ done `187 tests green`

**Ships**
- `identityId` / `personId` / `templateRef` separation enforced by types
- Vault service as a separate process with no read API — only `match()` and `enrol()`
- Versioned, unbundled consent records with withdrawal
- 1:N dedupe within a bounded scope, producing review flags rather than blocks
- Liveness as a server-issued challenge protocol: random nonce, single use, short TTL, constant-time compare
- Envelope encryption of every template under a master key the application plane never sees
- **Deferred to M4:** the in-browser camera and embedding model. The challenge protocol and the vector interface are built and tested; wiring an actual model to a webcam belongs with the scanner PWA, which needs the same code, and none of the M2 exit criteria depend on it.

**Exit criteria**
- No application service can retrieve a template — enforced by an integration test
- Withdrawing consent deletes the template and returns a verifiable receipt
- Enrolling the same face twice on two accounts raises a dedupe flag

---

### M3 — Contracts and issuance ✅ done `197 + 42 tests green`

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

### M4 — The gate ⚠ two of three done `239 + 42 tests green`

**Ships**
- Manifest builder: encrypted, event-scoped, TTL-bounded
- Delta sync with sequence numbers and staleness display
- Offline-first scanner PWA with local match and queued signed attestations
- Reconciliation job detecting double-entry after a partition
- Operator fallback flow with audit records

**Exit criteria**
- ✅ A scanner with the network physically off admits and denies correctly
- ⚠ **p95 decision latency under 800 ms on a mid-range Android device — NOT MET.**
  There is no Android device in this loop, so it has not been measured where it
  counts. What is known: our own decision path is 8.3 ms p95 against a
  12,000-credential gallery and scales linearly (`npm run bench:gate`), leaving
  ~420 ms for camera, liveness and embedding. Even a phone twenty times slower
  than this laptop stays inside the budget. That is an argument, not a
  measurement, and the criterion stays open until somebody runs it on hardware.
- ✅ A resale revokes the seller's credential at every lane within 30 seconds online

**Also outstanding from the Ships list**
- The PWA's `embed()` is a placeholder that hashes pixels and recognises nobody,
  and there is no liveness in the browser at all. Both are marked in the source.
  The scanner is a working operator console and an untrustworthy matcher, and it
  must not be pointed at a real queue until a licensed SDK replaces that function.

---

### M5 — Onsale defence ⚠ one of two done `280 + 42 tests green`

**Ships**
- Edge fair queue with signed admission tokens
- Inline risk scorer, p99 under 50 ms
- Feature store with identical transforms online and offline
- Nightly graph clustering over device, payment and behaviour edges
- Fraud review console — **API only.** `GET /v1/risk/clusters` returns each
  cluster with the evidence it was built on; the operator UI over it is not built.

**Exit criteria**
- ✅ A simulated 40,000 req/s onsale clears without origin saturation. 40,000
  arrivals in one second against an origin that serves 200/s: the origin sees
  exactly 200/s and never more, over any window.
- ⚠ **A scripted bot run blocked above 95% — NOT MET, and not reachable by this
  layer.** Pooled over 2,700 held-out sessions the inline scorer stops **94.6%**
  of scripted automation at a 0.86% human false-block rate. The ceiling is
  **94.7%**, because 12% of the evasive-bot persona is drawn from the human
  generator outright — those sessions are not *like* human sessions, they are
  human sessions, and no model recovers them. The scorer is therefore within
  0.1 points of the information limit, and >95% cannot be bought with a better
  model, only by moving traffic assumptions or accepting more false blocks.

  The system answer is the other two layers: the graph pass lifts clustered
  accounts at the *next* onsale, and the identity binding at the gate means a
  farmed ticket still meets the wrong face. There is a test asserting the
  ceiling is below 95%, so that nobody quietly lowers the assumption to make the
  number look better.

---

### M6 — Organizer self-serve `← next`

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
