/**
 * ReXell organizer console.
 *
 * A thin client over the organizer API. Every call it makes is one an organizer
 * could make with curl, which is deliberate: if this page can do something the
 * public API cannot, the API is incomplete.
 *
 * The key lives in localStorage and nowhere else. This page has no server of its
 * own beyond a static file host.
 */

const $ = (id) => document.getElementById(id);
/**
 * Where the API lives.
 *
 * From `/config.js`, which the static server writes from its own environment.
 * This used to read `?api=` from the query string, which meant a link could
 * point this page — including enrolment, where a face is captured — at a server
 * chosen by whoever wrote the link. The override survives on localhost, where
 * it is a development convenience rather than a vector.
 */
const API = (() => {
  const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
  const override = new URLSearchParams(location.search).get('api');
  if (override) {
    if (local) return override;
    console.error('Ignoring ?api= — an API origin from the URL is only honoured on localhost.');
  }
  return window.__REXELL_API__ ?? (local ? 'http://127.0.0.1:8080' : location.origin);
})();

let key = localStorage.getItem('rexell.key') ?? '';
let events = [];
let poller;

const money = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Compact form for stat tiles, where two decimal places is noise. */
const moneyShort = (paise) => {
  const r = paise / 100;
  if (r >= 10_000_000) return `₹${(r / 10_000_000).toFixed(2)}Cr`;
  if (r >= 100_000) return `₹${(r / 100_000).toFixed(2)}L`;
  if (r >= 1_000) return `₹${(r / 1_000).toFixed(1)}k`;
  return `₹${r.toFixed(0)}`;
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' toast-bad' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body;
}

// ─── navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['events', 'create', 'live', 'lanes', 'settlement', 'account'];
const CRUMBS = { events: 'Events', create: 'New event', live: 'Live', lanes: 'Lanes', settlement: 'Settlement', account: 'Account' };
const NEEDS_EVENT = new Set(['live', 'lanes', 'settlement']);

function go(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('#nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === view)));
  $('crumb').textContent = CRUMBS[view];
  $('switcher').hidden = !NEEDS_EVENT.has(view) || events.length === 0;
  $('liveDot').hidden = view !== 'live';
  location.hash = view;

  clearInterval(poller);
  if (view === 'events') renderEvents();
  if (view === 'live') {
    renderLive();
    // Polling, not a socket: a dashboard holding one socket per organizer is a
    // pool to run out of at exactly the wrong moment.
    poller = setInterval(renderLive, 5_000);
  }
  if (view === 'lanes') {
    renderLanes();
    // Slower than Live: a lane checking in is not news the way a fallback rate
    // climbing is, and this page is mostly read once while setting up doors.
    poller = setInterval(renderLanes, 15_000);
  }
  if (view === 'settlement') renderSettlement();
  if (view === 'account') renderAccount();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

$('eventPicker').addEventListener('change', () => {
  if (!$('view-live').hidden) renderLive();
  if (!$('view-lanes').hidden) renderLanes();
  if (!$('view-settlement').hidden) renderSettlement();
});

// ─── the ledger, when it needs a person ──────────────────────────────────────

/**
 * Two conditions, and only two, are worth interrupting somebody for.
 *
 * A chain write that was sent and never confirmed will not retry itself — on
 * purpose, because retrying a mint that may have landed is how one seat becomes
 * two tokens. It sits there until a person resolves it, so a person has to know.
 *
 * A backlog is different: the outbox retries that on its own, for ever, and a
 * chain being down for an hour is a Tuesday. It is only news when it stops
 * catching up.
 *
 * Neither affects anything a fan or an organizer can see. Tickets sell, resell
 * and open gates from the database, which is the source of truth for entry
 * permanently. That is why this says so in as many words: an alert that reads
 * like an outage, for a condition that is not one, teaches people to ignore it.
 */
const STRANDED_AFTER_MS = 60_000;
const BEHIND_AFTER_MS = 10 * 60_000;
let ledgerTimer;

const roughly = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
};

/** Start or stop the watch. Called from `loadMe`, which every route in ends at. */
function watchLedger() {
  clearInterval(ledgerTimer);
  if (!key) {
    $('ledgerAlert').hidden = true;
    return;
  }
  renderLedgerAlert();
  // Slow on purpose. This changes on the scale of an incident, not a render.
  ledgerTimer = setInterval(renderLedgerAlert, 30_000);
}

async function renderLedgerAlert() {
  const el = $('ledgerAlert');
  if (!el) return;

  let status;
  try {
    status = await call('/v1/chain/status');
  } catch {
    // The alert is not the place to report its own failure. If the API is
    // unreachable the rest of the console is already saying so, loudly.
    el.hidden = true;
    return;
  }

  if (!status.configured) {
    el.hidden = true;
    return;
  }

  const stranded = (status.submitted ?? 0) > 0 && (status.strandedMs ?? 0) > STRANDED_AFTER_MS;
  const behind = (status.oldestPendingAgeMs ?? 0) > BEHIND_AFTER_MS;

  if (!stranded && !behind) {
    el.hidden = true;
    return;
  }

  /*
   * Counts are deliberately left out.
   *
   * /v1/chain/status is platform-wide, so the number of confirmed writes is
   * roughly the number of tickets every organizer has sold. The age of the
   * oldest one is what a reader here needs, and it gives nothing away.
   */
  el.classList.toggle('is-bad', stranded);
  el.innerHTML = stranded
    ? `<strong>A ledger write needs attention.</strong> Something has been in flight for
       ${esc(roughly(status.strandedMs))} and will not retry on its own, because retrying a
       write that may already have landed could issue a second token for one seat.
       <span class="quiet">Your events, ticket sales and gates are unaffected — entry is
       decided from the database, not the chain. Contact ReXell support.</span>`
    : `<strong>The ledger is catching up.</strong> The oldest unwritten record is
       ${esc(roughly(status.oldestPendingAgeMs))} old.
       <span class="quiet">Nothing is blocked: tickets sell, resell and open gates as
       normal. This is the on-chain copy lagging, and it resolves itself.</span>`;
  el.hidden = false;
}

// ─── account ─────────────────────────────────────────────────────────────────

$('signupBtn').addEventListener('click', async () => {
  const name = $('orgName').value.trim();
  if (!name) return toast('Give the organization a name.', true);
  const invite = $('orgInvite').value.trim();
  try {
    const result = await call('/v1/organizers', {
      method: 'POST',
      // Only sent when supplied. An empty header on an open deployment would
      // be indistinguishable from a wrong one.
      ...(invite ? { headers: { 'x-signup-token': invite } } : {}),
      body: JSON.stringify({ name, contactEmail: $('orgEmail').value.trim() || undefined }),
    });
    key = result.apiKey;
    localStorage.setItem('rexell.key', key);
    $('keyValue').textContent = key;
    $('keyCard').hidden = false;
    $('signupCard').hidden = true;
    toast(`Welcome, ${name}.`);
    await loadMe();
  } catch (e) {
    toast(e.message, true);
    // A refused invite is the one failure with an obvious next action, so put
    // the cursor where that action is rather than leaving them to find it.
    if (/invitation|signup/i.test(e.message)) $('orgInvite')?.focus();
  }
});

$('useKeyBtn').addEventListener('click', () => {
  $('pasteCard').hidden = false;
  $('signupCard').hidden = true;
});
$('backToSignup').addEventListener('click', () => {
  $('pasteCard').hidden = true;
  $('signupCard').hidden = false;
});
$('pasteGo').addEventListener('click', async () => {
  key = $('pasteKey').value.trim();
  localStorage.setItem('rexell.key', key);
  await loadMe();
});
$('copyKey').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('keyValue').textContent);
  toast('Key copied. Store it somewhere safe.');
});
$('newKeyBtn').addEventListener('click', async () => {
  try {
    const result = await call('/v1/keys', { method: 'POST', body: JSON.stringify({ name: 'Key' }) });
    $('keyValue').textContent = result.apiKey;
    $('keyCard').hidden = false;
    await renderAccount();
    toast('New key issued. Copy it now.');
  } catch (e) {
    toast(e.message, true);
  }
});

async function loadMe() {
  if (!key) {
    clearInterval(ledgerTimer);
    $('ledgerAlert').hidden = true;
    return go('account');
  }
  try {
    const me = await call('/v1/me');
    $('whoami').innerHTML = `<strong style="color:var(--ink)">${esc(me.name)}</strong><br><span class="num" style="font-size:11px">${esc(me.organizerId)}</span>`;
    $('signupCard').hidden = true;
    $('pasteCard').hidden = true;
    await loadEvents();
    watchLedger();
    return true;
  } catch {
    $('whoami').textContent = 'Key not accepted';
    $('signupCard').hidden = false;
    // A key that is not accepted should not keep polling on its behalf.
    clearInterval(ledgerTimer);
    $('ledgerAlert').hidden = true;
    return false;
  }
}

async function renderAccount() {
  if (!key) return;
  try {
    const { keys } = await call('/v1/keys');
    $('keysCard').hidden = false;
    $('keysBody').innerHTML = keys
      .map(
        (k) => `<tr>
          <td class="key">${esc(k.name)}</td>
          <td class="num" style="font-size:12px">${esc(k.prefix)}</td>
          <td><div class="row gap-sm">${k.scopes.map((s) => `<span class="tag">${esc(s.split(':')[0])}</span>`).join('')}</div></td>
          <td class="hint">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
          <td class="right">${
            k.revokedAt
              ? '<span class="tag tag-bad">revoked</span>'
              : `<button class="btn btn-sm btn-danger" data-revoke="${esc(k.keyId)}">Revoke</button>`
          }</td>
        </tr>`,
      )
      .join('');

    document.querySelectorAll('[data-revoke]').forEach((b) =>
      b.addEventListener('click', async () => {
        await call(`/v1/keys/${b.dataset.revoke}`, { method: 'DELETE' });
        toast('Key revoked.');
        await renderAccount();
      }),
    );
  } catch (e) {
    toast(e.message, true);
  }
}

// ─── events ──────────────────────────────────────────────────────────────────

async function loadEvents() {
  try {
    events = (await call('/v1/events')).events;
  } catch {
    events = [];
  }
  const picker = $('eventPicker');
  const current = picker.value;
  picker.innerHTML = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  if (current && events.some((e) => e.id === current)) picker.value = current;
  $('switcher').hidden = !NEEDS_EVENT.has(location.hash.slice(1)) || events.length === 0;
}

async function renderEvents() {
  await loadEvents();
  if (!key) {
    // Attached rather than inline: the Content-Security-Policy is
    // script-src 'self' with no 'unsafe-inline', so an onclick attribute is
    // refused by the browser and the button quietly does nothing.
    $('eventsList').innerHTML = `<div class="card"><div class="empty">
      <h3>Not signed in</h3><p>Create an account or paste an existing API key to begin.</p>
      <div style="margin-top:16px"><button class="btn btn-primary" id="toAccount">Go to Account</button></div>
    </div></div>`;
    $('toAccount').addEventListener('click', () => go('account'));
    return;
  }
  if (events.length === 0) {
    return ($('eventsList').innerHTML = `<div class="card"><div class="empty">
      <h3>No events yet</h3><p>Create one and set your resale terms. It takes about a minute.</p>
      <div style="margin-top:16px"><button class="btn btn-primary" id="emptyCreate">New event</button></div>
    </div></div>`);
  }

  $('eventsList').innerHTML = `<div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Event</th><th class="n">Capacity</th><th>Doors</th><th></th></tr></thead>
    <tbody>${events
      .map(
        (e) => `<tr>
        <td class="key">${esc(e.name)}<div class="hint num" style="font-size:11px">${esc(e.id)}</div></td>
        <td class="n">${e.capacity.toLocaleString('en-IN')}</td>
        <td>${new Date(e.doorsOpenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td class="right"><button class="btn btn-sm" data-open="${esc(e.id)}">Open</button></td>
      </tr>`,
      )
      .join('')}</tbody></table></div></div>`;

  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      $('eventPicker').value = b.dataset.open;
      go('live');
    }),
  );
  $('emptyCreate')?.addEventListener('click', () => go('create'));
}

// ─── create ──────────────────────────────────────────────────────────────────

function previewDials() {
  const face = Number($('evFace').value) || 0;
  const capped = $('rsMode').value === 'capped';
  $('modeTag').textContent = capped ? 'Capped' : 'Soulbound';
  $('modeTag').className = capped ? 'tag tag-brand' : 'tag tag-warn';

  if (!capped) {
    $('dialPreview').className = 'note note-warn dial-preview';
    $('dialPreview').innerHTML =
      'Resale is <strong>off</strong>. The ticket cannot be transferred by anybody, at any price. Pair this with a face-value returns queue, or your support inbox becomes one.';
    return;
  }

  const cap = Number($('rsCap').value) || 100;
  const org = Number($('rsOrg').value) || 0;
  const rights = Number($('rsRights').value) || 0;
  const platform = 3;
  const ceiling = Math.floor(face * (cap / 100));
  const seller = 100 - org - rights - platform;

  $('dialPreview').className = 'note dial-preview';
  $('dialPreview').innerHTML = `A <b>₹${face.toLocaleString('en-IN')}</b> ticket resells for at most <b>₹${ceiling.toLocaleString('en-IN')}</b>.
    <div style="margin-top:10px;display:grid;gap:5px">
      ${[
        ['You', Math.floor((ceiling * org) / 100), org],
        ['Artist', Math.floor((ceiling * rights) / 100), rights],
        ['ReXell', Math.floor((ceiling * platform) / 100), platform],
        ['Seller keeps', Math.floor((ceiling * seller) / 100), seller],
      ]
        .map(
          ([label, amount, share]) =>
            `<div class="row" style="gap:8px"><span style="min-width:88px;font-size:12.5px">${label}</span>
             <span class="num" style="font-weight:600">₹${amount.toLocaleString('en-IN')}</span>
             <span class="hint">${share}%</span></div>`,
        )
        .join('')}
    </div>
    ${seller < 60 ? '<div class="hint" style="margin-top:9px">A seller keeping under 60% will mostly sell elsewhere instead.</div>' : ''}`;
}
['evFace', 'rsCap', 'rsOrg', 'rsRights', 'rsMode'].forEach((id) => $(id).addEventListener('input', previewDials));
previewDials();

$('createBtn').addEventListener('click', async () => {
  const btn = $('createBtn');
  btn.disabled = true;
  const now = Date.now();
  const doors = now + Number($('evDoors').value) * 86_400_000;
  const eventId = `evt_${Math.random().toString(36).slice(2, 10)}`;
  const capped = $('rsMode').value === 'capped';

  const event = {
    id: eventId,
    name: $('evName').value,
    capacity: Number($('evCapacity').value),
    salesOpenAt: now,
    salesCloseAt: doors - 2 * 3_600_000,
    doorsOpenAt: doors,
    endsAt: doors + 10 * 3_600_000,
    maxTicketsPerIdentity: Number($('evLimit').value),
    allowReentry: false,
    tiers: [
      {
        id: `${eventId}_ga`,
        eventId,
        name: 'General Admission',
        faceValue: Math.round(Number($('evFace').value) * 100),
        allocation: Number($('evAlloc').value),
        resale: {
          mode: capped ? 'capped' : 'bound',
          maxPriceBps: capped ? Math.round(Number($('rsCap').value) * 100) : 10_000,
          minPriceBps: capped ? Math.round(Number($('rsFloor').value) * 100) : 10_000,
          opensAt: now,
          closesAt: capped ? doors - 6 * 3_600_000 : doors,
          cooldownMs: Number($('rsCooldown').value) * 3_600_000,
          maxResalesPerTicket: capped ? 2 : 0,
          maxActiveListingsPerIdentity: capped ? 2 : 0,
          splits: {
            organizerBps: Math.round(Number($('rsOrg').value) * 100),
            platformBps: 300,
            rightsHolderBps: Math.round(Number($('rsRights').value) * 100),
          },
        },
      },
    ],
  };

  try {
    const created = await call('/v1/organizer/events', { method: 'POST', body: JSON.stringify({ event }) });
    $('createResult').innerHTML = `<div class="note">
      <strong>Created.</strong> ${created.tiers[0].ceilingMinor ? `Resale capped at ${money(created.tiers[0].ceilingMinor)}.` : 'Resale is off.'}
      <div class="hint" style="margin-top:8px">Policy hash <code>${esc(created.policyHash.slice(0, 20))}…</code> — anchored on chain, so these terms cannot be quietly changed once tickets sell.</div>
    </div>`;
    toast('Event created.');
    await loadEvents();
    $('eventPicker').value = eventId;
  } catch (e) {
    $('createResult').innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ─── live ────────────────────────────────────────────────────────────────────

/**
 * Provisioning for one lane, as the scanner expects it.
 *
 * A real deployment pushes this through mobile device management. This is the
 * same payload, handed over as a link, which is what makes "open a lane" one
 * click from the page that reports on the lanes.
 *
 * The scanner id is minted here and is new every time the link is built, so two
 * devices opened from this page are two lanes rather than one lane fighting
 * itself over which of them already admitted somebody.
 */
function laneConfig(eventId, scannerId, lane, gateGroup) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return btoa(
    JSON.stringify({
      apiBase: API,
      eventId,
      // Reusing an id re-provisions that same lane — which is what the Open
      // button next to an existing row has to do, or a device that reloads
      // would register itself twice and the admissions it already made would
      // belong to a lane nobody is watching.
      scannerId: scannerId || `scn_${suffix}`,
      lane: lane || suffix.slice(0, 2).toUpperCase(),
      // Empty admits any entrance. An event that splits its crowd by gate sets
      // this per device.
      gateGroup: gateGroup || '',
      allowReentry: false,
      // 'challenge' asks each person for a small movement, which is what stops
      // a photograph. 'off' is for a lane behind a staffed turnstile, where a
      // human is already doing that job — and the attestation records which,
      // so 'this lane never checked' cannot be confused with 'this lane was
      // satisfied'.
      liveness: 'challenge',
    }),
  );
}

/**
 * The lanes, on a tab of their own.
 *
 * This started life as a panel at the bottom of Live, under the sales tables
 * and the attendance tiles, which is a place nobody scrolls to while standing
 * at a door trying to set one up. Somebody looking for "where do I open a
 * lane" looks at the navigation.
 */
async function renderLanes() {
  const eventId = $('eventPicker').value;
  if (!eventId) {
    $('lanesBody').innerHTML =
      '<div class="card"><div class="empty"><h3>No event selected</h3><p>Lanes belong to an event — create one, then pick it above.</p></div></div>';
    return;
  }
  try {
    // Public: a scanner registers itself with no key.
    const lanes = await call(`/v1/events/${eventId}/scanners`);
    $('lanesBody').innerHTML = `<div class="grid">
        <!--
          The lanes, on the page that reports on them.

          The gate app existed at its own address long before this panel did, so
          the one screen an organizer needs on the night was the one screen they
          had to be told about separately — and there was no way to see how many
          lanes were open or when each last checked in. The numbers above are
          what these devices produce; they belong next to each other.
        -->
        <section class="card" style="grid-column:1/-1">
          <div class="card-head"><h2>Devices at the doors</h2><span class="spacer"></span>
            <span class="tag">${lanes.scanners.length} registered</span>
          </div>
          <div class="pad">
            ${laneTable(eventId, lanes.scanners)}

            <div class="row" style="margin-top:16px;gap:10px;align-items:end;flex-wrap:wrap">
              <label class="field" style="margin:0">
                <span>New lane</span>
                <input id="laneName" class="input" placeholder="A" style="max-width:120px">
              </label>
              <label class="field" style="margin:0">
                <span>Entrance (optional)</span>
                <input id="laneGate" class="input" placeholder="any" style="max-width:160px">
              </label>
              <button class="btn btn-primary" id="newLane">Open on this device</button>
              <button class="btn" id="copyLane">Copy link for another device</button>
            </div>
            <p class="hint" style="margin:12px 0 0">
              Opening a lane registers <em>this</em> device and pulls the sealed manifest for it.
              For a phone at the door, copy the link and open it there instead.
              An entrance name restricts the lane to tickets issued for that gate.
            </p>
          </div>
        </section>
      </div>`;
    wireLanes(eventId);
  } catch (e) {
    $('lanesBody').innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
  }
}

/** One row per registered lane, with a link that re-provisions that same lane. */
function laneTable(eventId, scanners) {
  if (scanners.length === 0) {
    return '<p class="hint" style="margin:0">No lane has registered yet. Opening one below registers the device it opens on.</p>';
  }
  const row = (sc) => {
    const seen = sc.lastSeenAt ? new Date(sc.lastSeenAt) : null;
    // Two minutes: a lane syncs every five seconds, so anything quieter than
    // this is a device that has stopped rather than one that is merely idle.
    const live = seen && Date.now() - seen.getTime() < 120_000;
    const href = `/gate/?config=${encodeURIComponent(laneConfig(eventId, sc.scannerId, sc.lane, sc.gateGroup))}`;
    return `<tr>
      <td class="key">${esc(sc.lane || '—')}</td>
      <td class="hint">${esc(sc.gateGroup || 'any')}</td>
      <td class="num" style="font-size:12px">${esc(sc.scannerId)}</td>
      <td>${seen ? `<span class="tag ${live ? 'tag-ok' : ''}">${seen.toLocaleTimeString()}</span>` : '<span class="hint">never</span>'}</td>
      <td class="right"><a class="btn btn-sm" target="_blank" rel="noopener" href="${href}">Open</a></td>
    </tr>`;
  };
  return `<table class="table"><thead><tr>
    <th>Lane</th><th>Entrance</th><th>Device</th><th>Last seen</th><th class="right"></th>
  </tr></thead><tbody>${scanners.map(row).join('')}</tbody></table>`;
}

function wireLanes(eventId) {
  const link = () =>
    `${location.origin}/gate/?config=${encodeURIComponent(
      laneConfig(eventId, '', $('laneName').value.trim(), $('laneGate').value.trim()),
    )}`;

  $('newLane')?.addEventListener('click', () => {
    window.open(link(), '_blank', 'noopener');
    // The lane registers itself on provision, so the table is one refresh
    // behind until it does.
    setTimeout(renderLive, 2500);
  });

  $('copyLane')?.addEventListener('click', async () => {
    const url = link();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. Open it on the device that will run the lane.');
    } catch {
      // Clipboard access is refused often enough — an insecure origin, a
      // permission prompt dismissed — that failing silently would look like
      // the button does nothing.
      prompt('Copy this link and open it on the lane device:', url);
    }
  });
}

async function renderLive() {
  const eventId = $('eventPicker').value;
  if (!eventId) {
    return ($('liveBody').innerHTML = `<div class="card"><div class="empty"><h3>No event selected</h3><p>Create an event to see it here.</p></div></div>`);
  }

  try {
    const a = await call(`/v1/events/${eventId}/analytics`);
    const hot = a.attendance.fallbackRate > 0.015;
    const hasScans = a.attendance.scans > 0;

    $('liveBody').innerHTML = `
      <div class="stats" style="margin-bottom:18px">
        <div class="stat"><b>${a.sales.sold.toLocaleString('en-IN')}</b><span>sold</span></div>
        <div class="stat"><b>${pct(a.sales.sellThrough)}</b><span>sell-through</span></div>
        <div class="stat"><b>${moneyShort(a.sales.grossMinor)}</b><span>gross</span></div>
        <div class="stat is-ok"><b>${moneyShort(a.resale.organizerCommissionMinor)}</b><span>resale commission</span></div>
      </div>

      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:18px">
        <section class="card">
          <div class="card-head"><h2>Tiers</h2></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Tier</th><th class="n">Face</th><th class="n">Sold</th><th class="n">Left</th><th class="n">Gross</th></tr></thead>
            <tbody>${a.sales.tiers
              .map(
                (t) => `<tr>
                <td class="key">${esc(t.name)}</td>
                <td class="n">${money(t.faceValueMinor)}</td>
                <td class="n">${t.sold}</td>
                <td class="n">${t.remaining}</td>
                <td class="n">${money(t.grossMinor)}</td>
              </tr>`,
              )
              .join('')}</tbody>
          </table></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Resale</h2><span class="spacer"></span><span class="hint">Money you would not otherwise see</span></div>
          <div class="pad">
            <div class="stats" style="border:0;border-radius:0;background:transparent;gap:0">
              <div class="stat" style="padding-left:0"><b>${a.resale.activeListings}</b><span>listed now</span></div>
              <div class="stat"><b>${a.resale.completed}</b><span>resold</span></div>
              <div class="stat"><b>${moneyShort(a.resale.volumeMinor)}</b><span>volume</span></div>
              <div class="stat"><b>${pct(a.resale.attachRate)}</b><span>attach rate</span></div>
            </div>
          </div>
        </section>

        <section class="card" style="grid-column:1/-1">
          <div class="card-head"><h2>At the gate</h2><span class="spacer"></span>
            ${hasScans ? `<span class="tag ${hot ? 'tag-bad' : 'tag-ok'}"><span class="dot"></span>${hot ? 'needs attention' : 'healthy'}</span>` : '<span class="tag">not started</span>'}
          </div>
          <div class="pad">
            <div class="stats" style="border:0;border-radius:0;background:transparent;gap:0">
              <div class="stat" style="padding-left:0"><b>${a.attendance.admitted}</b><span>admitted</span></div>
              <div class="stat"><b>${pct(a.attendance.turnout)}</b><span>turnout</span></div>
              <div class="stat ${hot ? 'is-bad' : ''}"><b>${pct(a.attendance.fallbackRate)}</b><span>fallback rate</span></div>
              <div class="stat ${a.attendance.doubleEntries ? 'is-bad' : ''}"><b>${a.attendance.doubleEntries}</b><span>double entries</span></div>
            </div>
            ${
              hot
                ? '<div class="note note-warn" style="margin-top:16px"><strong>Fallback is above 1.5%.</strong> The resolution desk is becoming the queue. Check lighting and camera angle at the busiest lane first.</div>'
                : ''
            }
          </div>
        </section>

      </div>`;
  } catch (e) {
    $('liveBody').innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
  }
}

// ─── settlement ──────────────────────────────────────────────────────────────

async function renderSettlement() {
  const eventId = $('eventPicker').value;
  if (!eventId) {
    return ($('settleBody').innerHTML = `<div class="card"><div class="empty"><h3>No event selected</h3><p>Create an event to see it here.</p></div></div>`);
  }

  try {
    const r = await call(`/v1/events/${eventId}/settlement/report`);

    if (r.resales === 0) {
      return ($('settleBody').innerHTML = `<div class="card"><div class="empty">
        <h3>No resales yet</h3><p>When a ticket resells, its split appears here — recomputed from your own policy, not asserted.</p>
      </div></div>`);
    }

    $('settleBody').innerHTML = `
      <div class="stats" style="margin-bottom:18px">
        <div class="stat"><b>${r.resales}</b><span>resales</span></div>
        <div class="stat"><b>${moneyShort(r.totals.volumeMinor)}</b><span>volume</span></div>
        <div class="stat is-ok"><b>${moneyShort(r.totals.organizerMinor)}</b><span>your share</span></div>
        <div class="stat"><b>${r.chain.confirmed}/${r.resales}</b><span>on chain</span></div>
      </div>

      ${
        r.reconciled
          ? `<div class="note" style="margin-bottom:18px"><strong>Reconciled.</strong> Every line recomputes from your own policy and balances to the paisa.${
              r.chain.awaiting ? ` ${r.chain.awaiting} still awaiting chain confirmation — normal, and payouts do not wait for it.` : ''
            }</div>`
          : `<div class="note note-bad" style="margin-bottom:18px"><strong>${r.discrepancies.length} discrepanc${r.discrepancies.length === 1 ? 'y' : 'ies'}. Do not pay out against this report.</strong>
             <div style="margin-top:6px">${r.discrepancies.map((d) => `<code>${esc(d.problem)}</code>`).join(' ')}</div></div>`
      }

      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>Ticket</th><th class="n">Sold for</th><th class="n">You</th><th class="n">Artist</th><th class="n">ReXell</th><th class="n">Seller</th><th>Checks</th></tr></thead>
        <tbody>${r.lines
          .map(
            (l) => `<tr>
            <td class="num" style="font-size:11.5px">${esc(l.ticketId.slice(0, 16))}…</td>
            <td class="n">${money(l.salePriceMinor)}</td>
            <td class="n" style="color:var(--ok);font-weight:600">${money(l.organizerMinor)}</td>
            <td class="n">${money(l.rightsHolderMinor)}</td>
            <td class="n">${money(l.platformMinor)}</td>
            <td class="n">${money(l.sellerMinor)}</td>
            <td><div class="row gap-sm">
              <span class="tag ${l.recomputed ? 'tag-ok' : 'tag-bad'}">policy</span>
              <span class="tag ${l.balanced ? 'tag-ok' : 'tag-bad'}">balances</span>
              <span class="tag ${l.onChain ? 'tag-ok' : ''}">${l.onChain ? 'on chain' : 'pending'}</span>
            </div></td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div></section>`;
  } catch (e) {
    $('settleBody').innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────

(async () => {
  const signedIn = key ? await loadMe() : false;
  const wanted = location.hash.slice(1);

  /*
   * `#join` is what the marketing site's "Join as Organizer" arrives on. It
   * is not a view — it is an intent — so it resolves to the account screen
   * and puts the cursor in the first field. Somebody who pressed a button
   * saying "join" should land on the form, not on a page listing the events
   * they do not have yet.
   *
   * An organizer already signed in on this device goes to their events
   * instead: they pressed the button out of habit, not to sign up twice.
   */
  if (wanted === 'join') {
    history.replaceState(null, '', location.pathname + location.search);
    go(signedIn ? 'events' : 'account');
    if (!signedIn) $('orgName')?.focus();
    return;
  }

  go(VIEWS.includes(wanted) ? wanted : signedIn ? 'events' : 'account');
})();
