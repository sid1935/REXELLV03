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
