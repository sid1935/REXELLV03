/**
 * Schema.
 *
 * SQLite for local development because there is no Docker on the dev machine,
 * but written to port to Postgres with a mechanical translation:
 *
 *   INTEGER PRIMARY KEY  →  BIGSERIAL / TEXT PRIMARY KEY (we use TEXT ids already)
 *   INTEGER (boolean)    →  BOOLEAN
 *   INTEGER (timestamp)  →  BIGINT, still epoch ms — never a local-time type
 *   TEXT (json)          →  JSONB
 *
 * Everything else — the CHECK constraints, the partial unique index, the
 * conditional updates the repositories rely on — behaves the same on both.
 *
 * Two constraints in here are load-bearing rather than decorative, and are
 * commented where they appear: the overselling CHECK on `tiers`, and the split
 * balance CHECK on `settlements`. Both encode an invariant that the domain layer
 * also enforces. Enforcing it twice is deliberate: application code can be
 * bypassed by a migration script or a support engineer with a SQL console.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- ─── identity ────────────────────────────────────────────────────────────────
-- In production this table lives in the identity service's own database and no
-- other service can reach it. Face templates are NOT here and never will be —
-- they live in the vault (M2), which has no read path at all.

CREATE TABLE IF NOT EXISTS persons (
  person_id     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  contact       TEXT NOT NULL,
  gov_id_ref    TEXT,
  kyc_state     TEXT NOT NULL DEFAULT 'none',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS identities (
  identity_id        TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES persons(person_id),
  dedupe_cluster_id  TEXT,
  risk_tier          TEXT NOT NULL DEFAULT 'standard',
  enrolled           INTEGER NOT NULL DEFAULT 0,
  blocked            INTEGER NOT NULL DEFAULT 0,
  age_years          INTEGER,
  created_at         INTEGER NOT NULL
);

-- Append-only. Withdrawal writes a new row; it never mutates one. The record of
-- what was consented to, when, and against which wording is the legal artefact.
CREATE TABLE IF NOT EXISTS consents (
  consent_id    TEXT PRIMARY KEY,
  identity_id   TEXT NOT NULL REFERENCES identities(identity_id),
  purpose       TEXT NOT NULL,
  text_version  TEXT NOT NULL,
  granted_at    INTEGER,
  withdrawn_at  INTEGER,
  created_at    INTEGER NOT NULL
);

-- ─── inventory ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizers (
  organizer_id  TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id                  TEXT PRIMARY KEY,
  organizer_id              TEXT NOT NULL REFERENCES organizers(organizer_id),
  name                      TEXT NOT NULL,
  capacity                  INTEGER NOT NULL CHECK (capacity > 0),
  sales_open_at             INTEGER NOT NULL,
  sales_close_at            INTEGER NOT NULL,
  doors_open_at             INTEGER NOT NULL,
  ends_at                   INTEGER NOT NULL,
  max_tickets_per_identity  INTEGER NOT NULL CHECK (max_tickets_per_identity > 0),
  minimum_age               INTEGER,
  allow_reentry             INTEGER NOT NULL DEFAULT 0,
  -- Anchors the resale terms. An organizer must not be able to change the deal
  -- after inventory has sold; this hash is what goes on chain at event creation.
  policy_hash               TEXT NOT NULL,
  chain_address             TEXT,
  manifest_sequence         INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  CHECK (sales_close_at > sales_open_at),
  CHECK (ends_at > doors_open_at)
);

CREATE TABLE IF NOT EXISTS tiers (
  tier_id                           TEXT PRIMARY KEY,
  event_id                          TEXT NOT NULL REFERENCES events(event_id),
  name                              TEXT NOT NULL,
  face_value                        INTEGER NOT NULL CHECK (face_value >= 0),
  allocation                        INTEGER NOT NULL CHECK (allocation > 0),
  sold                              INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held                              INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  resale_mode                       TEXT NOT NULL CHECK (resale_mode IN ('bound','capped')),
  max_price_bps                     INTEGER NOT NULL,
  min_price_bps                     INTEGER NOT NULL,
  resale_opens_at                   INTEGER NOT NULL,
  resale_closes_at                  INTEGER NOT NULL,
  cooldown_ms                       INTEGER NOT NULL,
  max_resales_per_ticket            INTEGER NOT NULL,
  max_active_listings_per_identity  INTEGER NOT NULL,
  organizer_bps                     INTEGER NOT NULL,
  platform_bps                      INTEGER NOT NULL,
  rights_holder_bps                 INTEGER NOT NULL,
  -- Overselling is an invariant, not a warning. If application code ever gets
  -- this wrong, the write fails here instead of at a turnstile in front of a
  -- person holding a ticket for a seat that does not exist.
  CHECK (sold + held <= allocation),
  CHECK (organizer_bps + platform_bps + rights_holder_bps <= 10000)
);
CREATE INDEX IF NOT EXISTS tiers_by_event ON tiers(event_id);

-- ─── buying ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS holds (
  hold_id      TEXT PRIMARY KEY,
  tier_id      TEXT NOT NULL REFERENCES tiers(tier_id),
  identity_id  TEXT NOT NULL REFERENCES identities(identity_id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  state        TEXT NOT NULL CHECK (state IN ('active','converted','released')),
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS holds_expiring ON holds(state, expires_at);

CREATE TABLE IF NOT EXISTS orders (
  order_id      TEXT PRIMARY KEY,
  identity_id   TEXT NOT NULL REFERENCES identities(identity_id),
  event_id      TEXT NOT NULL REFERENCES events(event_id),
  tier_id       TEXT NOT NULL REFERENCES tiers(tier_id),
  hold_id       TEXT REFERENCES holds(hold_id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'INR',
  state         TEXT NOT NULL CHECK (state IN ('pending','paid','failed','expired','refunded')),
  auth_ref      TEXT,
  -- Stored with the order so a dispute months later can be reasoned about using
  -- the score that was actually acted on, not a score recomputed today.
  risk_verdict  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER
);
CREATE INDEX IF NOT EXISTS orders_by_identity ON orders(identity_id, event_id);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id          TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(event_id),
  tier_id            TEXT NOT NULL REFERENCES tiers(tier_id),
  owner_identity_id  TEXT NOT NULL REFERENCES identities(identity_id),
  order_id           TEXT REFERENCES orders(order_id),
  state              TEXT NOT NULL CHECK (state IN ('held','issued','listed','redeemed','refunded','revoked')),
  acquired_at        INTEGER NOT NULL,
  resale_count       INTEGER NOT NULL DEFAULT 0,
  seat               TEXT,
  redeemed_at        INTEGER,
  revoked_reason     TEXT,
  -- Chain state is deliberately nullable and deliberately behind. A ticket is
  -- valid and sellable long before it is minted; the chain catches up.
  token_id           TEXT,
  mint_state         TEXT NOT NULL DEFAULT 'pending' CHECK (mint_state IN ('pending','submitted','confirmed','failed')),
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_by_owner ON tickets(owner_identity_id, event_id);
CREATE INDEX IF NOT EXISTS tickets_by_event ON tickets(event_id, state);

-- ─── resale ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listings (
  listing_id          TEXT PRIMARY KEY,
  ticket_id           TEXT NOT NULL REFERENCES tickets(ticket_id),
  seller_identity_id  TEXT NOT NULL REFERENCES identities(identity_id),
  price_minor         INTEGER NOT NULL CHECK (price_minor >= 0),
  state               TEXT NOT NULL CHECK (state IN ('active','sold','cancelled','expired')),
  listed_at           INTEGER NOT NULL,
  sold_at             INTEGER,
  buyer_identity_id   TEXT REFERENCES identities(identity_id)
);
-- One live listing per ticket. Without this, a ticket can be sold twice on the
-- secondary market during a race, which is a refund and an angry fan.
CREATE UNIQUE INDEX IF NOT EXISTS listings_one_active_per_ticket
  ON listings(ticket_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS listings_by_seller ON listings(seller_identity_id, state);

CREATE TABLE IF NOT EXISTS settlements (
  settlement_id        TEXT PRIMARY KEY,
  listing_id           TEXT NOT NULL REFERENCES listings(listing_id),
  ticket_id            TEXT NOT NULL REFERENCES tickets(ticket_id),
  sale_price_minor     INTEGER NOT NULL,
  organizer_minor      INTEGER NOT NULL,
  platform_minor       INTEGER NOT NULL,
  rights_holder_minor  INTEGER NOT NULL,
  seller_minor         INTEGER NOT NULL,
  chain_tx             TEXT,
  created_at           INTEGER NOT NULL,
  -- The split must balance exactly. This is the same invariant computeSplits
  -- guarantees, asserted a second time at the point money is recorded.
  CHECK (organizer_minor + platform_minor + rights_holder_minor + seller_minor = sale_price_minor)
);

-- ─── the gate ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS manifest_deltas (
  event_id    TEXT NOT NULL REFERENCES events(event_id),
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('add','rebind','revoke')),
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (event_id, seq)
);

CREATE TABLE IF NOT EXISTS entry_attestations (
  attestation_id     TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(event_id),
  ticket_id          TEXT,
  identity_id        TEXT,
  lane               TEXT NOT NULL,
  decided_at         INTEGER NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('admit','deny','fallback')),
  code               TEXT NOT NULL,
  match_score        REAL NOT NULL,
  manifest_sequence  INTEGER NOT NULL,
  offline            INTEGER NOT NULL,
  received_at        INTEGER NOT NULL
);
-- A scanner that reconnects twice re-uploads its queue. The same decision at the
-- same lane at the same instant is one decision, not two.
CREATE UNIQUE INDEX IF NOT EXISTS attestations_dedupe
  ON entry_attestations(lane, decided_at, ticket_id);
CREATE INDEX IF NOT EXISTS attestations_by_event ON entry_attestations(event_id, outcome);

CREATE TABLE IF NOT EXISTS risk_signals (
  signal_id    TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL REFERENCES identities(identity_id),
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  observed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS risk_signals_by_identity ON risk_signals(identity_id, observed_at);

-- ─── plumbing ────────────────────────────────────────────────────────────────

-- Every write endpoint is retryable. A fan on a flaky connection at an onsale
-- will hit "buy" more than once, and must not end up with two tickets.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  response_json  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
`;
