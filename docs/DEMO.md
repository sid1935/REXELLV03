# ReXell — the demo

Twelve minutes, four screens, one claim: a ticket that cannot be scalped,
counterfeited, or resold above a price the organizer set.

```bash
npm start          # vault, API, organizer console, fan app
npm run seed:demo  # six events, sixty fans, a night at a gate
npm run scanner    # the gate, when you get to it
```

`seed:demo` prints two organizer API keys. Keep that terminal open — you will
paste one into the console.

> **The events are illustrative.** They are built from public listings so the
> demo looks like a real Saturday rather than a wall of "Test Event 1". ReXell
> has no relationship with any of these events, venues or promoters, the
> organizer accounts are fictional, and no ticket is real. Sources are at the
> bottom of this page.

---

## Before you start

| | |
|---|---|
| Fan app | http://127.0.0.1:8120 |
| Organizer console | http://127.0.0.1:8110 |
| Gate scanner | http://127.0.0.1:8100 — the seed prints a provisioning link |
| API | http://127.0.0.1:8080 |

Open the fan app in a narrow window, or in your browser's device mode. It is
built for a phone and looks wrong at 1400px, the way a phone app should.

**The camera needs `localhost` or HTTPS.** On `127.0.0.1` it works. If you are
demoing over a shared screen with no camera, every capture step falls back to a
deterministic stand-in and the flow still runs — say so rather than letting
somebody think the camera failed.

---

## The catalogue, and why it is shaped this way

The six events are not variations on one event. Each one sets the resale dials
differently, because that is the product.

| Event | Resale | The point |
|---|---|---|
| Lollapalooza India 2027 | 110% cap, 7% to the organizer | A market they take a cut of beats a market they cannot see |
| Guns N' Roses, Bengaluru | 105% cap, 2 per person; **Gold Circle bound** | A scalper magnet. The tier where fraud hurts most cannot be resold at all |
| Anyma, Mumbai | 115% cap, 4% to the artist | The rights-holder takes a share of the secondary market |
| NH7 Weekender, Pune | 110% cap, 6 per person | Sells to groups of friends, not individuals |
| Chet Faker, Bengaluru | **Off** | A 3,500-capacity room does not need a secondary market |
| Bengaluru FC vs Mohun Bagan | 110% cap; **West Stand bound** | Happening tonight — doors open, box office still selling, gate running |

That last one is the one to demo. It is the only event where a live sale and a
live gate are both true at the same moment, which is a real Saturday.

---

## The twelve minutes

### 1 · A fan gets a ReXell ID — 2 min

Open the **fan app**. It says *Get your ReXell ID*, because there is nothing to
show until there is.

Tap **Set it up**.

> **Say this:** every other ticketing app starts with an email and a password.
> This starts with the only thing a scalper cannot resell.

**The consent screen is the one to slow down on.** It asks for one thing, for
one purpose, and it is not bundled with terms of service or a marketing tick
box. Read the three lines out:

- a template, not a photograph — the pictures never leave the phone
- for opening a gate, and nothing else
- twelve months, or until withdrawal, which deletes it and returns a receipt

And the line underneath: **you can attend without this.** Staffed entry is
always available. An organizer will ask; a regulator will ask twice.

Then capture. The server picks the challenge action and a nonce, so a template
captured earlier cannot be replayed into a later enrolment.

---

### 2 · Buying — 2 min

**Discover** shows six events with the resale terms on the card, before anybody
has spent anything. Note that Chet Faker says **no resale** in the same place
the others say **resale capped**. Nobody has to read terms to find that out.

Open **Bengaluru FC vs Mohun Bagan**, pick General Stand, buy one.

Then go to **Tickets**. This is the screen the whole product is about.

> **Say this:** there is no QR code here. Not hidden behind a tap — there isn't
> one. A screenshot of this screen is a screenshot of a receipt. There is
> nothing to forward, nothing to sell in a WhatsApp group, and nothing to
> counterfeit.

---

### 3 · Reselling, and the moment that matters — 3 min

Go to **Resell**. Your ticket is there with the ceiling already stated:
₹330 on a ₹300 ticket.

List it. Try to type a higher number first — the field will not take it, and
the API would refuse it too, and so would the contract. Three layers, and only
the third one is the enforcement.

Now, in the **organizer console**, paste the *Southside Venues* key
(Account → *I already have a key*), pick the Bengaluru FC event, and open
**Settlement**.

> **Say this:** every line here is recomputed from the organizer's own policy
> and checked to balance to the paisa. They are not being asked to trust a
> total. And the commission column is money that, today, they do not see at all
> — the scalper keeps it.

The **on chain** column will say *pending* for a few seconds and then
*confirmed*. Point at it while it is pending:

> Nothing waits for that. The ticket sold, the gate works, the organizer gets
> paid. The chain is the receipt, not the rail.

---

### 4 · The gate — 3 min

```bash
npm run scanner
```

It prints a provisioning link with a config for lane 1. Open it. The lane
registers itself, pulls a **sealed** manifest, and asks for the key separately —
the key only releases two hours before doors, so a manifest sitting on a stolen
device the week before is inert.

Tap **Simulate** a few times. Green, and fast.

Now the part worth staging. In the fan app, resell a ticket to another fan.
Then in the scanner, tap **Sync**, and scan the seller.

> **Say this:** she has the same face she had a minute ago. The ticket is
> somebody else's now, so the gate says no. That revocation is what makes the
> binding worth anything — without it, the face is decoration.

Then turn the network off — genuinely, disable wifi — and keep scanning. It
keeps working, the pill says **offline**, and the queue counter climbs. Turn it
back on and watch the queue drain.

> A venue's cellular collapses under crowd load at exactly the moment the gate
> needs it. A gate that stops working when nine thousand people arrive is not a
> gate.

---

### 5 · What the organizer sees — 2 min

Back in the console, **Live**.

- **sold / sell-through / gross** — the ordinary numbers
- **resale commission** — the number that is new
- **fallback rate** — the number that decides whether the queue moves. Above
  1.5% the tile turns red and says *needs attention*, because at that point the
  resolution desk is becoming the queue

Then **Account → Keys**. The organizer signed themselves up, issued their own
key, created their own event, provisioned their own gate and read their own
settlement. Nobody at ReXell touched any of it.

> **Say this:** that is the margin. Sixty events a year with a ReXell employee
> at every gate is a services business. This is the other thing.

---

## Three questions you will be asked

**"What if the camera doesn't recognise me?"**
It falls back to a staffed lane — always. There is a test asserting a failed
match can never produce a denial. A 1.5% false-reject rate handled that way
costs somebody ninety seconds; handled the other way it is 1.5% of the crowd
sent home, and one video.

**"What about someone who won't scan their face?"**
They queue at the resolution desk with ID, at no extra cost and no worse
position. It is a product requirement, not a concession — a gate that works
only for some bodies is not a gate. The consent screen says so out loud.

**"Can't a scalper just pay people to buy for them?"**
Yes, and the behavioural model barely catches them, because they are real
people on real phones. Our own measurement is 94.6% of *scripted* automation
stopped against a 94.7% information ceiling — the honest number, not a round
one. What stops a human farm is the ticket meeting the wrong face at the gate.
Three layers; only the third is decisive.

---

## What to say before anybody asks

Two things in this build are prototypes, and volunteering them buys more
credibility than being caught on them:

- **The face matcher recognises nobody.** Both the fan app and the scanner ship
  a placeholder that folds pixels into a vector, and neither has liveness
  detection — a printed photo would pass. The architecture around it is real
  and tested; a licensed SDK replaces one function.
- **The p95 latency claim is unmeasured on a phone.** Our own decision path is
  8.3 ms against a 12,000-credential gallery, leaving about 420 ms for camera
  and embedding inside the 800 ms budget. That is an argument, not a
  measurement, until it runs on a mid-range Android.

Neither is a coding problem. Both need a purchase order.

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| `Cannot reach the API` | `npm start` is not running, or is still booting — give it ten seconds |
| `This database already has events in it` | Already seeded. Stop the stack, delete `.dev.sqlite*` and `.dev-vault.sqlite*`, start again |
| Enrolment returns 503 | The vault did not come up. Check the `vault` lines in the `npm start` output |
| Every purchase is `NOT_ENROLLED` | Correct. The dev server requires real enrolment — there is no shortcut flag |
| The gate says `TOO_EARLY` | Manifest keys release two hours before doors. Only the Bengaluru FC event is live |
| Camera does nothing | Not `localhost`, or permission denied. The fallback still runs the flow |

**Reset between demos:**

```bash
# stop npm start first
rm -f .dev.sqlite* .dev-vault.sqlite*
npm start && npm run seed:demo
```

---

## Sources for the event data

Names, venues and dates were taken from public listings in September 2026 and
adapted for the demo; prices and allocations are illustrative.

- [Lollapalooza India 2027 dates announced — Rolling Stone India](https://rollingstoneindia.com/lollapalooza-india-2027-dates-announced/)
- [India concert calendar 2026 — StayVista](https://www.stayvista.com/blog/concerts-in-india-2026/)
- [Lollapalooza India 2027 — Music Festival Wizard](https://www.musicfestivalwizard.com/festivals/lollapalooza-india-2027/)
- [Bengaluru FC home stadium, Sree Kanteerava](https://www.bengalurufc.com/home-stadium)
- [Bengaluru FC venue — Indian Super League](https://www.indiansuperleague.com/clubs/656-bengaluru-fc-profile/venue)
