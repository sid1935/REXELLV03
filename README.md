# ReXell

Fraud-proof ticketing. A ticket is not a document you hold — it is a binding
between an on-chain entitlement and your face, governed by resale rules the
organizer writes themselves.

- **Architecture:** `docs/architecture.html`
- **Development plan:** `docs/ROADMAP.md`
- **Business plan:** `docs/business-plan.html`

## Getting started

```bash
npm install
npm run check     # typecheck + tests
```

## Layout

```
packages/
  domain/         business rules — no I/O, no dependencies, no clock
```

Everything else (`apps/api`, `apps/web`, `apps/gate`, `packages/contracts`)
arrives in M1–M4 per the roadmap.

## The rules that live in `@rexell/domain`

| Module | Answers |
|---|---|
| `money.ts` | Integer minor units and basis points. No float touches money, ever. |
| `event.ts` | Event, tier and resale policy, plus the validation that anchors them. |
| `ticket.ts` | The ticket state machine and its legal transitions. |
| `purchase.ts` | Can this identity buy this, now? Risk, enrolment, limits, age, inventory. |
| `resale.ts` | Can this be listed, at this price, right now? Can this buyer take it? |
| `splits.ts` | Where the resale money goes, summing exactly with no dust. |
| `manifest.ts` | The offline gate manifest and its delta sync, including gap detection. |
| `entry.ts` | The gate decision, and double-entry reconciliation after a partition. |

### Four invariants worth knowing before you change anything

1. **Splits always balance.** `organizer + platform + rightsHolder + seller`
   equals the sale price exactly, for every input. Fixed shares floor; the seller
   takes the remainder, so rounding never favours the platform.
2. **A failed biometric match never denies entry.** It falls back to a staffed
   lane. A system that turns a false reject into a refusal turns a 1.5% error rate
   into 1.5% of the crowd being sent home.
3. **Delta sync stops at a gap.** Applying delta 7 without 6 could admit someone
   whose credential 6 revoked, so the scanner stops and tells the operator instead
   of guessing.
4. **A resale revokes the seller's credential.** Without that edge, the biometric
   binding is decoration. There is an end-to-end test for exactly this.

### Deliberate non-goals in this package

No dates, no `Date.now()`, no network, no database, no logging. Every function
that cares about time takes `now` as an argument, because a scanner's clock is not
necessarily correct and a resale window closing has to be testable at an exact
millisecond.

## Layout, as built

```
packages/domain/     business rules — no I/O, no dependencies, no clock
packages/biometrics/ face vectors, thresholds, liveness challenges, template sealing
packages/contracts/  Solidity — TicketNFT, ResaleController, RoyaltySplitter, AccessRegistry
packages/db/         schema and repositories — owns every SQL statement
apps/api/            Fastify HTTP surface over the domain
apps/vault/          the biometric vault — separate process, separate keys, no read path
scripts/seed.ts      builds the 12,000-cap festival and drives a night through it
```

## Try it

```bash
npm run seed
```

Stands up the vault on its own port, enrols forty fans through it (consent →
challenge → capture → dedupe), refuses a template POSTed without a challenge and
a consent form that bundles biometrics with terms of service, sells 79 tickets,
runs ten capped resales, refuses a scalper at ₹6,000 and a VIP resale outright,
simulates a night at the gate, reconciles it, and finally withdraws one fan's
consent and verifies the deletion receipt. Every number it prints is computed.

## Where the invariants are enforced

Twice, on purpose. Application code can be bypassed by a migration or a support
engineer with a SQL console, so the two that move money or admit people are also
constraints in the schema:

| Invariant | Domain | Database |
|---|---|---|
| Splits sum exactly to the sale price | `computeSplits` | `CHECK` on `settlements` |
| A tier cannot oversell its allocation | `validateEvent`, `reserve` | `CHECK (sold + held <= allocation)` |
| One live listing per ticket | `evaluateListing` | partial unique index on `listings` |
| A re-uploaded scan is one scan | `findDoubleEntries` | unique index on `entry_attestations` |

## Three things about the API worth knowing

1. **The clock is injected.** Nothing calls `Date.now()` below `buildApp`. Hold
   expiry, resale windows and cooldowns are all testable at an exact instant —
   no test sleeps for eight minutes.
2. **Reservation is one conditional `UPDATE`.** The availability check and the
   decrement are the same atomic write, so two requests for the last seat cannot
   both succeed. Turning that into a read-then-write oversells under load and the
   failure only surfaces at a turnstile.
3. **Failed responses are never cached against an idempotency key.** A `SOLD_OUT`
   must stay retryable, because a hold expiring puts that inventory back.

## The vault boundary

`apps/vault` is the only thing that ever holds a face template, and it has no
route that returns one. Not to the API, not to an operator, not to anybody. What
callers get back is a boolean and a score.

Three tests hold that line, in `apps/vault/test/no-read-path.test.ts`:

1. The router is enumerated at runtime and asserted to contain no read-shaped GET.
2. Every endpoint response is scanned for vector-shaped data — named fields and
   bare long numeric arrays alike, because a leak with an innocuous field name is
   still a leak.
3. The vault's `package.json` is asserted not to depend on `@rexell/db` or
   `@rexell/domain`. Without that edge, no future change can join a template to a
   name by importing its way there.

The API side mirrors it: `VaultClient` declares its own wire types rather than
importing the vault's, and has no method capable of fetching a template.

### Why templates are not hashed

Two captures of one face produce different vectors — `packages/biometrics` has a
test asserting exactly that, and exports no equality function at all. Comparison
is cosine similarity against a stored template, which is why the template has to
live somewhere, which is why that somewhere is a vault with no read path. Hashing
a face and putting the hash on chain does not work and would be unrevocable if it
did.

### Consent

Append-only, purpose-scoped, and versioned. A withdrawal is a new row, never an
update — the record of what was agreed to and when outlives the permission. Asking
for biometric consent bundled with anything else is a 422 before it reaches the
database.

## The chain is never on the critical path

A ticket is valid, sellable and scannable the moment its database row exists.
Minting happens later, in batches, through an outbox — so an L2 outage delays the
ledger and nothing else. There is a test that stops the sequencer, then sells a
ticket, resells it, and opens a gate, all with the chain down the whole time.

```bash
npm run test:contracts   # 42 contract tests, Hardhat + viem
npm run check            # typecheck, 197 TS tests, then the contracts
```

### What the contracts refuse to do

| Attack | Result |
|---|---|
| Owner calls `transferFrom` on a bound ticket | reverts `TicketIsBound` |
| Owner calls `transferFrom` on a capped ticket | reverts `TransfersMustGoThroughController` |
| The resale controller tries to move a bound ticket | reverts `ResaleDisabled` |
| Anyone calls `approve` or `setApprovalForAll` | reverts `ApprovalsDisabled` — no marketplace can list it |
| List one paisa above the ceiling | reverts `PriceAboveCeiling` |
| Mint to an identity nobody is bound to | reverts `IdentityNotBound` |
| Two identities bound to one wallet | reverts `AccountInUse` |
| Deploy tiers allocating more than capacity | reverts `CapacityExceeded` |

There is no `Open` resale mode in the enum. The absence of that third member is a
product decision, and it is why a ReXell ticket cannot reach an NFT marketplace.

### The splits are checked against each other

`RoyaltySplit.compute` in Solidity and `computeSplits` in `packages/domain` must
agree to the paisa, or an organizer's statement stops matching the chain. The
contract test imports the TypeScript function and runs both over the same sweep
of awkward prices — a differential test, not two independent guesses.
