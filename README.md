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
packages/domain/   business rules — no I/O, no dependencies, no clock
packages/db/       schema and repositories — owns every SQL statement
apps/api/          Fastify HTTP surface over the two above
scripts/seed.ts    builds the 12,000-cap festival and drives a night through it
```

## Try it

```bash
npm run seed
```

Creates the Sunburn Weekender from the business plan, sells 79 tickets, runs ten
capped resales, refuses a scalper at ₹6,000 and a VIP resale outright, then
simulates a night at the gate and reconciles it. Every number it prints is
computed, not hardcoded.

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
