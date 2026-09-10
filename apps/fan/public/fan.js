/**
 * ReXell, for fans.
 *
 * Four screens and one idea: there is nothing to show at the gate. Every other
 * ticketing app puts a QR code on the ticket screen; this one puts the reason
 * there isn't one.
 *
 * ⚠ `embed()` is a placeholder that folds pixels into a vector and recognises
 * nobody, and there is no liveness detection here — a printed photo would pass.
 * Both are marked below. The flow around them is real; the matcher is not, and
 * a licensed SDK replaces exactly one function.
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
const DIMS = 128;

const state = {
  identityId: localStorage.getItem('rexell.fan.id') ?? '',
  enrolled: localStorage.getItem('rexell.fan.enrolled') === 'true',
  view: 'tickets',
  tickets: [],
  events: [],
};

const money = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const moneyExact = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' toast-bad' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

async function call(path, body, method) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(parsed?.error?.message ?? `Something went wrong (${res.status})`);
  return parsed;
}

// ─── the placeholder matcher ─────────────────────────────────────────────────

const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 160 });
const ctx = canvas.getContext('2d', { willReadFrequently: true });

/**
 * ⚠ REPLACE ME. A real implementation runs a licensed face-recognition model
 * over the frame and returns its embedding. This folds downsampled luminance
 * into a vector: deterministic, fast, and incapable of recognising a person.
 */
function embed(image) {
  const acc = new Float32Array(DIMS);
  const { data, width, height } = image;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      acc[(x * 31 + y * 17) % DIMS] += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    }
  }
  let sum = 0;
  for (const v of acc) sum += v * v;
  const mag = Math.sqrt(sum) || 1;
  return Array.from(acc, (v) => v / mag);
}

// ─── navigation ──────────────────────────────────────────────────────────────

const TITLES = { tickets: 'Your tickets', discover: 'Discover', sell: 'Resell', you: 'You' };

function go(view) {
  state.view = view;
  for (const v of Object.keys(TITLES)) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === view)));
  $('pageTitle').textContent = TITLES[view];
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

// ─── sheets ──────────────────────────────────────────────────────────────────

function sheet(html) {
  const host = $('sheetHost');
  host.innerHTML = `<div class="sheet" id="activeSheet"><div class="sheet-panel"><div class="grabber"></div>${html}</div></div>`;
  const el = $('activeSheet');
  el.addEventListener('click', (e) => {
    if (e.target === el) closeSheet();
  });
  return el;
}
function closeSheet() {
  $('sheetHost').innerHTML = '';
}

// ─── identity and enrolment ──────────────────────────────────────────────────

async function ensureIdentity() {
  if (state.identityId) return state.identityId;
  const { identityId } = await call('/v1/identities', {});
  state.identityId = identityId;
  localStorage.setItem('rexell.fan.id', identityId);
  return identityId;
}

/**
 * Consent, on its own screen.
 *
 * Never bundled with anything, because bundling it is the exact pattern Article
 * 9 exists to prohibit — and because a person agreeing to hand over their face
 * deserves to be doing one thing at a time.
 */
function consentSheet() {
  sheet(`
    <div class="eyebrow">Step 1 of 2</div>
    <h2 style="margin:8px 0 6px">Permission for your face</h2>
    <p class="lede" style="margin-bottom:16px">We are asking for this on its own, and for one purpose. It is not bundled with anything else.</p>

    <div class="stack gap-sm" style="gap:10px">
      ${[
        ['What we keep', 'A mathematical template — not a photograph. The pictures never leave your phone.'],
        ['What it is for', 'Opening the gate at events you have a ticket for. Nothing else.'],
        ['How long', 'Twelve months, or until you withdraw. Withdrawing deletes it and we send you a receipt.'],
      ]
        .map(
          ([title, body]) => `<div class="consent-item">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>
            <div><div style="font-weight:600;font-size:13.5px">${title}</div><div class="hint">${body}</div></div>
          </div>`,
        )
        .join('')}
    </div>

    <div class="stack gap-sm" style="margin-top:18px">
      <button class="btn btn-primary btn-lg btn-block" id="consentYes">I agree — continue</button>
      <button class="btn btn-quiet btn-block" id="consentNo">Not now</button>
    </div>
    <p class="hint" style="text-align:center;margin-top:12px">You can attend without this. Staffed entry is always available.</p>
  `);

  $('consentNo').addEventListener('click', closeSheet);
  $('consentYes').addEventListener('click', async () => {
    try {
      const id = await ensureIdentity();
      await call(`/v1/identities/${id}/consents`, { purposes: ['biometric_enrolment'] });
      enrolSheet();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function enrolSheet() {
  sheet(`
    <div class="eyebrow">Step 2 of 2</div>
    <h2 style="margin:8px 0 6px">Set up your face</h2>
    <p class="lede" style="margin-bottom:16px">Look at the camera and follow the prompt. This takes about ten seconds.</p>

    <div class="viewfinder" id="vf">
      <video id="cam" playsinline muted autoplay></video>
      <div class="viewfinder-ring"></div>
      <div class="viewfinder-hint"><span class="tag tag-brand" id="challengeTag">starting camera…</span></div>
    </div>

    <div class="steps" style="margin:16px 0">
      <div class="step" id="s1"></div><div class="step" id="s2"></div><div class="step" id="s3"></div>
    </div>

    <button class="btn btn-primary btn-lg btn-block" id="captureBtn" disabled>Capture</button>
    <button class="btn btn-quiet btn-block" style="margin-top:8px" id="enrolCancel">Cancel</button>
    <p class="hint" style="margin-top:14px"><strong>Prototype:</strong> this build ships a placeholder matcher with no liveness detection. It is not fit for a real gate.</p>
  `);

  $('enrolCancel').addEventListener('click', () => {
    stopCamera();
    closeSheet();
  });

  startCamera().then((ok) => {
    $('challengeTag').textContent = ok ? 'look straight ahead' : 'no camera — tap capture to simulate';
    $('captureBtn').disabled = false;
    if (ok) $('vf').classList.add('is-live');
  });

  $('captureBtn').addEventListener('click', async () => {
    const btn = $('captureBtn');
    btn.disabled = true;
    try {
      const id = await ensureIdentity();
      $('s1').classList.add('done');

      // The server picks the nonce and the action, so a template captured
      // earlier cannot be replayed into a later enrolment.
      const challenge = await call(`/v1/identities/${id}/enrolment/challenge`, {});
      $('challengeTag').textContent = String(challenge.kind).replace('_', ' ');
      $('s2').classList.add('done');
      await new Promise((r) => setTimeout(r, 700));

      const vector = captureVector();
      await call(`/v1/identities/${id}/enrolment`, {
        scope: 'global',
        vector,
        liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.96, actionCompleted: true },
      });

      $('s3').classList.add('done');
      state.enrolled = true;
      localStorage.setItem('rexell.fan.enrolled', 'true');
      stopCamera();
      await new Promise((r) => setTimeout(r, 400));
      closeSheet();
      toast('Your ReXell ID is ready.');
      render();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  });
}

let stream;
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 480 } });
    $('cam').srcObject = stream;
    return true;
  } catch {
    $('cam').hidden = true;
    return false;
  }
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
}
function captureVector() {
  const video = $('cam');
  if (video && video.videoWidth > 0) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return embed(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }
  // No camera: a stable pseudo-face derived from the identity, so the demo
  // still runs on a laptop with the lid shut.
  let seed = 0;
  for (const ch of state.identityId) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  const v = Array.from({ length: DIMS }, (_, i) => Math.sin(i * 0.7 + seed) + Math.cos(i * 0.31 - seed));
  const mag = Math.hypot(...v);
  return v.map((x) => x / mag);
}

// ─── data ────────────────────────────────────────────────────────────────────

async function loadTickets() {
  if (!state.identityId) return (state.tickets = []);
  try {
    const { tickets } = await call(`/v1/identities/${state.identityId}/tickets`);
    // Enrich with the event each ticket belongs to, so the card can name it.
    const eventIds = [...new Set(tickets.map((t) => t.eventId))];
    const details = await Promise.all(eventIds.map((id) => call(`/v1/events/${id}`).catch(() => null)));
    const byId = new Map(details.filter(Boolean).map((e) => [e.id, e]));
    state.tickets = tickets.map((t) => ({ ...t, event: byId.get(t.eventId) }));
  } catch {
    state.tickets = [];
  }
}

// ─── render ──────────────────────────────────────────────────────────────────

function render() {
  $('idTag').hidden = !state.identityId;
  $('idTag').className = `tag ${state.enrolled ? 'tag-ok' : 'tag-warn'}`;
  $('idTag').textContent = state.enrolled ? 'ID ready' : 'ID incomplete';

  if (state.view === 'tickets') renderTickets();
  if (state.view === 'discover') renderDiscover();
  if (state.view === 'sell') renderSell();
  if (state.view === 'you') renderYou();
}

function setupPrompt(reason) {
  return `<div class="card"><div class="empty">
    <h3>Get your ReXell ID</h3>
    <p>${reason}</p>
    <div style="margin-top:18px"><button class="btn btn-primary" id="startSetup">Set it up</button></div>
  </div></div>`;
}

async function renderTickets() {
  const host = $('view-tickets');

  if (!state.enrolled) {
    host.innerHTML = setupPrompt('Your face is your ticket, so you need to set it up once before you can buy.');
    $('startSetup').addEventListener('click', consentSheet);
    return;
  }

  host.innerHTML = '<div class="card" style="height:220px" class="skel"></div>';
  await loadTickets();
  const live = state.tickets.filter((t) => t.state === 'issued' || t.state === 'listed');

  if (live.length === 0) {
    host.innerHTML = `<div class="card"><div class="empty">
      <h3>No tickets yet</h3><p>Find something to go to.</p>
      <div style="margin-top:18px"><button class="btn btn-primary" id="toDiscover">Discover events</button></div>
    </div></div>`;
    $('toDiscover').addEventListener('click', () => go('discover'));
    return;
  }

  host.innerHTML = `<div class="stack gap-lg">${live.map(ticketCard).join('')}</div>`;
}

/**
 * The ticket.
 *
 * Where every other ticketing app puts a QR code, this puts the reason there
 * isn't one. It is the only screen that has to carry the whole product idea.
 */
function ticketCard(t) {
  const event = t.event;
  return `<article class="ticket">
    <div class="ticket-top">
      <div class="eyebrow">${t.state === 'listed' ? 'Listed for resale' : 'Admit one'}</div>
      <h2>${esc(event?.name ?? 'Event')}</h2>
      <div class="when">${event ? when(event.doorsOpenAt) : ''}</div>
    </div>

    <div class="perf" style="--paper:var(--surface)"></div>

    <div class="ticket-face">
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>
        <circle cx="12" cy="10.5" r="2.6"/><path d="M7.8 17a4.6 4.6 0 0 1 8.4 0"/>
      </svg>
      <h3>Nothing to scan</h3>
      <p>Walk up to the gate and look at the camera. Your face is the ticket — there is no code to screenshot, forward or lose.</p>
    </div>

    <dl class="ticket-meta">
      <div><dt>Ticket</dt><dd class="num" style="font-size:11.5px">${esc(t.id.slice(4, 14))}</dd></div>
      <div><dt>Resold</dt><dd>${t.resaleCount}×</dd></div>
      <div><dt>Status</dt><dd style="color:var(--${t.state === 'listed' ? 'warn' : 'ok'})">${t.state === 'listed' ? 'Listed' : 'Valid'}</dd></div>
    </dl>
  </article>`;
}

async function renderDiscover() {
  const host = $('view-discover');
  host.innerHTML = '<div class="card skel" style="height:120px"></div>';

  let listing;
  try {
    listing = await call('/v1/discover?limit=30');
  } catch (e) {
    host.innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
    return;
  }

  if (listing.events.length === 0) {
    host.innerHTML = `<div class="card"><div class="empty">
      <h3>Nothing on sale</h3><p>When an organizer opens a sale, it shows up here.</p>
    </div></div>`;
    return;
  }

  // The catalogue carries what a card needs; the tiers come from the event view
  // when somebody actually taps through.
  host.innerHTML = `<div class="stack gap-lg">${listing.events.map(discoverCard).join('')}</div>`;
  document.querySelectorAll('[data-event]').forEach((b) =>
    b.addEventListener('click', () => openEvent(b.dataset.event)),
  );
}

const BAND_TAG = { available: '', limited: 'tag-warn', last_few: 'tag-warn', sold_out: 'tag-bad' };

function discoverCard(e) {
  return `<button class="event-card" data-event="${esc(e.id)}" ${e.availability === 'sold_out' ? 'disabled' : ''}>
    <div class="event-strip"></div>
    <div class="body">
      <h3>${esc(e.name)}</h3>
      <div class="hint" style="margin-bottom:10px">${esc(e.organizer)} · ${when(e.doorsOpenAt)}</div>
      <div class="row">
        <span class="price">from ${money(e.fromMinor)}</span>
        <span class="spacer"></span>
        <span class="tag ${BAND_TAG[e.availability]}">${esc(e.availabilityLabel)}</span>
        ${e.resaleAllowed ? '<span class="tag tag-brand">resale capped</span>' : '<span class="tag">no resale</span>'}
      </div>
    </div>
  </button>`;
}

async function openEvent(eventId) {
  let event;
  try {
    event = await call(`/v1/events/${eventId}`);
  } catch (e) {
    return toast(e.message, true);
  }
  state.events = [event, ...state.events.filter((x) => x.id !== eventId)];

  sheet(`
    <div class="eyebrow">${esc(event.organizer ?? '')}</div>
    <h2 style="margin:8px 0 4px">${esc(event.name)}</h2>
    <div class="hint" style="margin-bottom:16px">${when(event.doorsOpenAt)}</div>

    <div class="stack gap-sm" style="margin-bottom:16px">
      ${event.tiers
        .map(
          (t) => `<button class="event-card" data-tier="${esc(t.id)}" ${t.availability === 'sold_out' ? 'disabled' : ''}>
            <div class="body">
              <div class="row">
                <div>
                  <h3>${esc(t.name)}</h3>
                  <div class="hint">${t.resale.allowed ? `Resale capped at ${moneyExact(t.resale.ceilingMinor)}` : 'Cannot be resold'}</div>
                </div>
                <span class="spacer"></span>
                <div style="text-align:right">
                  <div class="price">${money(t.faceValueMinor)}</div>
                  <span class="tag ${BAND_TAG[t.availability]}" style="margin-top:5px">${esc(t.availabilityLabel)}</span>
                </div>
              </div>
            </div>
          </button>`,
        )
        .join('')}
    </div>

    <p class="hint">Up to ${event.maxTicketsPerIdentity} per person. Terms anchored as <code style="font-size:10px">${esc(event.policyHash.slice(0, 12))}…</code> — they cannot change once tickets sell.</p>
    <button class="btn btn-quiet btn-block" style="margin-top:14px" id="closeEvent">Close</button>
  `);

  $('closeEvent').addEventListener('click', closeSheet);
  document.querySelectorAll('[data-tier]').forEach((b) =>
    b.addEventListener('click', () => buySheet(b.dataset.tier)),
  );
}

function buySheet(tierId) {
  const event = state.events.find((e) => e.tiers.some((t) => t.id === tierId));
  const tier = event?.tiers.find((t) => t.id === tierId);
  if (!tier) return;

  sheet(`
    <div class="eyebrow">${esc(event.name)}</div>
    <h2 style="margin:8px 0 14px">${esc(tier.name)}</h2>

    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><b>${money(tier.faceValueMinor)}</b><span>face value</span></div>
      <div class="stat"><b>${event.maxTicketsPerIdentity}</b><span>max per person</span></div>
    </div>

    <div class="note" style="margin-bottom:16px">
      ${
        tier.resale.allowed
          ? `If you cannot go, you can resell for up to <strong>${moneyExact(tier.resale.ceilingMinor)}</strong> — the ceiling the organizer set. No more than that, to anyone.`
          : 'This ticket cannot be resold. It is tied to you.'
      }
    </div>

    <label class="field" style="margin-bottom:16px"><span>How many</span>
      <select id="qty">${Array.from({ length: Math.min(4, event.maxTicketsPerIdentity) }, (_, i) => `<option>${i + 1}</option>`).join('')}</select>
    </label>

    <button class="btn btn-primary btn-lg btn-block" id="confirmBuy">Buy</button>
    <button class="btn btn-quiet btn-block" style="margin-top:8px" id="cancelBuy">Not now</button>
  `);

  $('cancelBuy').addEventListener('click', closeSheet);
  $('confirmBuy').addEventListener('click', async () => {
    const btn = $('confirmBuy');
    btn.disabled = true;
    btn.textContent = 'Buying…';
    try {
      const order = await call('/v1/orders', {
        identityId: state.identityId,
        tierId,
        quantity: Number($('qty').value),
      });
      await call(`/v1/orders/${order.orderId}/pay`, {});
      closeSheet();
      toast('Bought. Your face is your ticket.');
      go('tickets');
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = 'Buy';
    }
  });
}

async function renderSell() {
  const host = $('view-sell');
  if (!state.enrolled) {
    host.innerHTML = setupPrompt('Set up your ReXell ID first.');
    $('startSetup').addEventListener('click', consentSheet);
    return;
  }

  await loadTickets();
  const sellable = state.tickets.filter((t) => t.state === 'issued');
  const listed = state.tickets.filter((t) => t.state === 'listed');

  if (sellable.length === 0 && listed.length === 0) {
    host.innerHTML = `<div class="card"><div class="empty"><h3>Nothing to resell</h3>
      <p>Tickets you own show up here when the organizer allows resale.</p></div></div>`;
    return;
  }

  host.innerHTML = `
    ${
      listed.length
        ? `<div class="note" style="margin-bottom:16px"><strong>${listed.length} listed.</strong> The moment one sells, your face stops opening that gate and the buyer's starts.</div>`
        : ''
    }
    <div class="stack gap-lg">
      ${sellable
        .map((t) => {
          const tier = t.event?.tiers.find((x) => x.id === t.tierId);
          const capped = tier?.resale.allowed === true;
          return `<div class="card"><div class="pad">
            <h3 style="margin-bottom:3px">${esc(t.event?.name ?? 'Event')}</h3>
            <div class="hint" style="margin-bottom:14px">${t.event ? when(t.event.doorsOpenAt) : ''}</div>
            ${
              capped
                ? `<div class="row"><span class="hint">Ceiling ${moneyExact(tier.resale.ceilingMinor)}</span><span class="spacer"></span>
                   <button class="btn btn-sm btn-primary" data-list="${esc(t.id)}" data-ceiling="${tier.resale.ceilingMinor}">List for resale</button></div>`
                : '<span class="tag tag-warn">resale off for this event</span>'
            }
          </div></div>`;
        })
        .join('')}
    </div>`;

  document.querySelectorAll('[data-list]').forEach((b) =>
    b.addEventListener('click', () => listSheet(b.dataset.list, Number(b.dataset.ceiling))),
  );
}

function listSheet(ticketId, ceiling) {
  sheet(`
    <h2 style="margin-bottom:6px">List for resale</h2>
    <p class="lede" style="margin-bottom:16px">The organizer capped this at <strong>${moneyExact(ceiling)}</strong>. You cannot ask for more, and neither can anybody else.</p>
    <label class="field" style="margin-bottom:16px"><span>Your price (₹)</span>
      <input class="num-input" id="askPrice" type="number" value="${Math.round(ceiling / 100)}" max="${Math.round(ceiling / 100)}">
    </label>
    <button class="btn btn-primary btn-lg btn-block" id="confirmList">List it</button>
    <button class="btn btn-quiet btn-block" style="margin-top:8px" id="cancelList">Cancel</button>
  `);

  $('cancelList').addEventListener('click', closeSheet);
  $('confirmList').addEventListener('click', async () => {
    try {
      await call('/v1/listings', {
        ticketId,
        identityId: state.identityId,
        priceMinor: Math.round(Number($('askPrice').value) * 100),
      });
      closeSheet();
      toast('Listed.');
      renderSell();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

async function renderYou() {
  const host = $('view-you');

  if (!state.identityId) {
    host.innerHTML = setupPrompt('Create your ReXell ID to buy tickets.');
    $('startSetup').addEventListener('click', consentSheet);
    return;
  }

  let consents = { current: [], history: [] };
  try {
    consents = await call(`/v1/identities/${state.identityId}/consents`);
  } catch {
    /* offline */
  }
  const biometric = consents.current.find((c) => c.purpose === 'biometric_enrolment');

  host.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="pad">
      <div class="eyebrow">Your ReXell ID</div>
      <div class="num" style="font-size:12.5px;margin:6px 0 14px;color:var(--ink-2)">${esc(state.identityId)}</div>
      <div class="row">
        <span class="tag ${state.enrolled ? 'tag-ok' : 'tag-warn'}"><span class="dot"></span>${state.enrolled ? 'Face set up' : 'Face not set up'}</span>
        <span class="tag ${biometric?.state === 'granted' ? 'tag-ok' : ''}">${esc(biometric?.state ?? 'no consent')}</span>
      </div>
    </div></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Your face</h2></div>
      <div class="pad stack gap-lg">
        <p class="hint">We hold a mathematical template, never a photograph. It is scoped to events you hold tickets for and it is deleted twelve months after your last one.</p>
        ${
          state.enrolled
            ? `<button class="btn btn-danger btn-block" id="withdrawBtn">Withdraw permission and delete</button>`
            : `<button class="btn btn-primary btn-block" id="setupBtn">Set up my face</button>`
        }
      </div>
    </div>

    ${
      consents.history.length
        ? `<div class="card">
            <div class="card-head"><h2>Consent history</h2></div>
            <div class="table-wrap"><table>
              <thead><tr><th>What</th><th>When</th><th></th></tr></thead>
              <tbody>${consents.history
                .map(
                  (h) => `<tr>
                    <td class="key" style="font-size:12.5px">${esc(h.purpose.replace(/_/g, ' '))}</td>
                    <td class="hint">${new Date(h.recordedAt).toLocaleDateString()}</td>
                    <td class="right"><span class="tag ${h.withdrawnAt ? 'tag-bad' : 'tag-ok'}">${h.withdrawnAt ? 'withdrawn' : 'granted'}</span></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>
            <div class="pad"><p class="hint">Kept even after you withdraw. What you agreed to, and when, is the record — deleting it would defeat the point of having it.</p></div>
          </div>`
        : ''
    }`;

  $('setupBtn')?.addEventListener('click', consentSheet);
  $('withdrawBtn')?.addEventListener('click', async () => {
    if (!confirm('Delete your face template? You can set it up again later, and you can still attend with staffed entry.')) return;
    try {
      const result = await call(`/v1/identities/${state.identityId}/consents/biometric_enrolment/withdraw`, {});
      state.enrolled = false;
      localStorage.setItem('rexell.fan.enrolled', 'false');
      sheet(`
        <h2 style="margin-bottom:6px">Deleted</h2>
        <p class="lede" style="margin-bottom:14px">Your face template is gone. Here is the receipt — it is signed, so you can check it against us later.</p>
        <div class="stats" style="margin-bottom:14px">
          <div class="stat"><b>${result.receipt.deletedCount}</b><span>templates deleted</span></div>
          <div class="stat"><b>${new Date(result.receipt.deletedAt).toLocaleDateString()}</b><span>on</span></div>
        </div>
        <div class="field"><span>Receipt</span><div class="keyout num" style="font-size:11px;word-break:break-all;background:var(--sunk);border:1px solid var(--rule);border-radius:var(--r);padding:11px">${esc(result.receipt.receiptId)}<br>${esc(result.receipt.digest.slice(0, 48))}…</div></div>
        <button class="btn btn-block" style="margin-top:16px" onclick="document.getElementById('sheetHost').innerHTML=''">Close</button>
      `);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// ─── boot ────────────────────────────────────────────────────────────────────

go('tickets');
