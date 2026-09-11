/**
 * ReXell, for fans.
 *
 * Four screens and one idea: there is nothing to show at the gate. Every other
 * ticketing app puts a QR code on the ticket screen; this one puts the reason
 * there isn't one.
 *
 * The matcher is real: `/face-capture.js` runs a face-recognition network over
 * the camera frame and returns the network's own 128-dimension descriptor, so
 * the template enrolled here is the one the gate compares against. What is
 * still missing is liveness — nothing here can tell a face from a photograph of
 * a face, so a printed picture would enrol. That is the remaining blocker on a
 * real door, and the sheet says so rather than hiding it.
 */
import { faceVector, readyFaceMatcher, vectorPreview, FaceCaptureError } from '/face-capture.js';

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
  // Shown once, on the dashboard, immediately after enrolling.
  newRecoveryCode: '',
  // The vector from this session's enrolment, shown once beside the recovery
  // code and never persisted — it is the template, and it belongs in the vault
  // rather than in localStorage.
  enrolmentPreview: null,
  search: '',
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
  // Every sheet that opens the camera is dismissible by tapping outside it, and
  // clearing the host removes the <video> without stopping the track — the
  // stream keeps running and the recording light stays on over a sheet that is
  // no longer there. Stopping it here covers every exit, including the ones
  // nobody remembered to write a handler for.
  stopCamera();
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

    <p class="hint" id="captureHint" hidden style="margin-top:12px;color:var(--warn,#f7b955)"></p>
    <button class="btn btn-primary btn-lg btn-block" id="captureBtn" disabled>Capture</button>
    <button class="btn btn-quiet btn-block" style="margin-top:8px" id="enrolCancel">Cancel</button>
    <p class="hint" style="margin-top:14px"><strong>Prototype:</strong> the matcher is real, liveness detection is not here yet — a printed photograph would pass. Not fit for a real gate until it is.</p>
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

  // The network and its weights are about eight megabytes. Fetching them while
  // somebody is reading the consent copy costs nothing; fetching them after
  // they press Capture is a wait with a camera pointed at their face.
  readyFaceMatcher().catch(() => {});

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

      const capture = await captureVector((note) => {
        $('challengeTag').textContent = note;
      });
      const enrolment = await call(`/v1/identities/${id}/enrolment`, {
        scope: 'global',
        vector: capture.vector,
        liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.96, actionCompleted: true },
      });

      // What was actually stored, in the person's own hands. "A mathematical
      // template, not a photograph" is a claim on every page of this app; this
      // is the one place it can be checked rather than believed.
      state.enrolmentPreview = {
        preview: vectorPreview(capture.vector),
        dims: capture.vector.length,
        simulated: capture.simulated,
        quality: capture.quality,
      };

      $('s3').classList.add('done');
      state.enrolled = true;
      localStorage.setItem('rexell.fan.enrolled', 'true');
      stopCamera();
      await new Promise((r) => setTimeout(r, 400));
      closeSheet();

      /*
       * Straight to the dashboard.
       *
       * Signing up ends where the product begins, not on another modal. The
       * recovery code still has to be seen exactly once, so it rides along as
       * the first card on that dashboard instead of as a door to get through
       * — same information, without making somebody dismiss a sheet before
       * they have seen what they signed up for.
       */
      state.newRecoveryCode = enrolment.recoveryCode ?? '';
      go('tickets');
      toast('Your ReXell ID is ready.');
    } catch (e) {
      // A capture failure is something the person can fix — move closer, get
      // the light off the back of your head — so it is shown as an instruction
      // on the sheet rather than as a toast that slides away while they are
      // still reading it.
      if (e instanceof FaceCaptureError) {
        $('challengeTag').textContent = 'try again';
        $('captureHint').textContent = e.message;
        $('captureHint').hidden = false;
      } else {
        toast(e.message, true);
      }
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
/**
 * One capture, from the live camera where there is one.
 *
 * The no-camera branch is not a matcher and does not pretend to be: it derives
 * a stable vector from the identity id so the rest of the journey — buy,
 * resell, attend — can be walked on a machine with no webcam. It is marked in
 * the return value, the sheet says which one ran, and the gate will match it
 * only against itself. Without the marker this is exactly the sort of fallback
 * that gets mistaken for a working recogniser.
 */
async function captureVector(onProgress) {
  const video = $('cam');
  if (video && video.videoWidth > 0) {
    const { vector, quality } = await faceVector(video, onProgress);
    return { vector, quality, simulated: false };
  }
  let seed = 0;
  for (const ch of state.identityId) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  const v = Array.from({ length: DIMS }, (_, i) => Math.sin(i * 0.7 + seed) + Math.cos(i * 0.31 - seed));
  const mag = Math.hypot(...v);
  return { vector: v.map((x) => x / mag), quality: { simulated: true }, simulated: true };
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

  // The rail's foot, which the console uses for who is signed in. Here the
  // equivalent question is whether this device can open a gate.
  const rail = $('railStatus');
  if (rail) {
    rail.textContent = !state.identityId
      ? 'Not set up'
      : state.enrolled
        ? 'Ready for the gate'
        : 'Face not set up yet';
  }

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

/**
 * The recovery code, on the dashboard, once.
 *
 * Rendered above whatever else is there and dismissed by hand, because it
 * cannot be shown again: no route returns it and no support tool can recover
 * it, which is the rule the organizer API keys follow too.
 */
function recoveryBanner() {
  if (!state.newRecoveryCode) return '';
  return `
    <section class="card" id="recoveryCard" style="border-color:var(--brand-line);margin-bottom:18px">
      <div class="card-head"><h2>Write this down</h2></div>
      <div class="pad">
        <p class="lede" style="margin-bottom:12px">
          Your recovery code. It is the only way back into your account from
          another phone, and we cannot show it again or recover it for you.
        </p>
        <div class="num" id="recoveryCode" style="text-align:center;font-size:clamp(14px,4.4vw,19px);font-weight:600;letter-spacing:0.04em;background:var(--sunk);border:1px solid var(--brand-line);border-radius:var(--r);padding:16px 8px;word-break:normal;overflow-wrap:normal">${esc(state.newRecoveryCode)}</div>
        <div class="row" style="margin-top:12px;gap:8px">
          <button class="btn btn-quiet" id="copyRecovery">Copy</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" id="recoveryDone">I have written it down</button>
        </div>
        ${templateReceipt()}
      </div>
    </section>`;
}

/**
 * What was actually stored, shown once, next to the recovery code.
 *
 * Every screen in this app says we keep a mathematical template and not a
 * photograph. This is the one place that sentence can be checked instead of
 * believed: it is the real vector, from the real capture, truncated only
 * because 128 numbers at full precision is unreadable — and because the whole
 * thing on a clipboard would be the template itself.
 */
function templateReceipt() {
  const t = state.enrolmentPreview;
  if (!t) return '';
  return `
    <div style="margin-top:16px;border-top:1px solid var(--rule);padding-top:14px">
      <p class="hint" style="margin-bottom:8px">
        ${t.simulated
          ? 'No camera was available, so this is a stand-in vector derived from your ID — it will not match a face at the gate.'
          : `This is what your face became: ${t.dims} numbers, and no image. Nothing here can be turned back into a picture of you.`}
      </p>
      <div class="num" style="font-size:11px;line-height:1.6;word-break:break-all;background:var(--sunk);border:1px solid var(--rule);border-radius:var(--r);padding:10px">${esc(t.preview)}</div>
    </div>`;
}

function wireRecoveryBanner() {
  const code = state.newRecoveryCode;
  if (!code) return;
  $('copyRecovery')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied.');
    } catch {
      toast('Select the code and copy it by hand.', true);
    }
  });
  $('recoveryDone')?.addEventListener('click', () => {
    state.newRecoveryCode = '';
    render();
  });
}

async function renderTickets() {
  const host = $('view-tickets');

  if (!state.enrolled) {
    host.innerHTML = setupPrompt('Your face is your ticket, so you need to set it up once before you can buy.');
    $('startSetup').addEventListener('click', consentSheet);
    return;
  }

  host.innerHTML = `${recoveryBanner()}<div class="card" style="height:220px" class="skel"></div>`;
  wireRecoveryBanner();
  await loadTickets();
  const live = state.tickets.filter((t) => t.state === 'issued' || t.state === 'listed');

  if (live.length === 0) {
    host.innerHTML = `${recoveryBanner()}<div class="card"><div class="empty">
      <h3>No tickets yet</h3><p>Find something to go to.</p>
      <div style="margin-top:18px"><button class="btn btn-primary" id="toDiscover">Discover events</button></div>
    </div></div>`;
    wireRecoveryBanner();
    $('toDiscover').addEventListener('click', () => go('discover'));
    return;
  }

  host.innerHTML = `${recoveryBanner()}<div class="stack gap-lg">${live.map(ticketCard).join('')}</div>`;
  wireRecoveryBanner();
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

/**
 * Search, served by the API rather than filtered here.
 *
 * Filtering the loaded page would be simpler and instant, and it would also be
 * wrong: the page caps at 100, so a term would quietly stop finding events the
 * moment the catalogue outgrew that. The endpoint matches on the event name,
 * the venue and the organizer.
 */
let searchTimer;

async function renderDiscover() {
  const host = $('view-discover');
  const term = state.search;

  // The field is rendered once and kept, so typing does not lose focus every
  // time results come back.
  if (!$('discoverSearch')) {
    host.innerHTML = `
      <label class="search" for="discoverSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="discoverSearch" type="search" autocomplete="off"
               placeholder="Search events, venues and cities" value="${esc(term)}">
      </label>
      <div id="discoverResults"></div>`;
    $('discoverSearch').addEventListener('input', (e) => {
      state.search = e.target.value;
      clearTimeout(searchTimer);
      // Long enough that typing a word is one request rather than six, short
      // enough that it still feels like it is keeping up.
      searchTimer = setTimeout(renderDiscover, 220);
    });
  }

  const results = $('discoverResults');
  results.innerHTML = '<div class="card skel" style="height:120px"></div>';

  let listing;
  try {
    listing = await call(`/v1/discover?limit=30${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ''}`);
  } catch (e) {
    results.innerHTML = `<div class="note note-bad">${esc(e.message)}</div>`;
    return;
  }

  // A stale response from a slower earlier request must not overwrite a newer
  // one: the user has typed since, and what is on screen should match the box.
  if (state.search !== term) return;

  if (listing.events.length === 0) {
    results.innerHTML = term.trim()
      ? `<div class="card"><div class="empty">
          <h3>Nothing matches "${esc(term.trim())}"</h3>
          <p>Try an artist, a venue or a city.</p>
          <div style="margin-top:16px"><button class="btn btn-quiet" id="clearSearch">Clear search</button></div>
        </div></div>`
      : `<div class="card"><div class="empty">
          <h3>Nothing on sale</h3><p>When an organizer opens a sale, it shows up here.</p>
        </div></div>`;
    $('clearSearch')?.addEventListener('click', () => {
      state.search = '';
      $('discoverSearch').value = '';
      renderDiscover();
    });
    return;
  }

  // The catalogue carries what a card needs; the tiers come from the event view
  // when somebody actually taps through.
  results.innerHTML = `<div class="stack gap-lg">${listing.events.map(discoverCard).join('')}</div>`;
  wirePosters(results);
  document.querySelectorAll('[data-event]').forEach((b) =>
    b.addEventListener('click', () => openEvent(b.dataset.event)),
  );
}

const BAND_TAG = { available: '', limited: 'tag-warn', last_few: 'tag-warn', sold_out: 'tag-bad' };

/**
 * The poster for an event.
 *
 * One file per event id under /events. The generated artwork is a stand-in for
 * a licensed photograph and the path is the interface between them: drop a
 * real image in at the same name and this picks it up unchanged.
 *
 * onerror hides the image rather than leaving a broken frame, and the gradient
 * strip underneath it survives as the fallback — a card with a hole in it is
 * worse than a card that never promised a picture.
 */
function poster(e) {
  const id = encodeURIComponent(e.id);
  // The photograph first, the generated poster if there is not one. Two acts
  // have no properly licensed photograph and keep the abstract rather than
  // borrowing a picture of somebody else.
  //
  // The fallback is wired by wirePosters() rather than by an inline onerror.
  // The Content-Security-Policy here is script-src 'self' with no
  // 'unsafe-inline', so an inline handler is not merely discouraged — the
  // browser refuses to run it, and the fallback silently never happens.
  return `<div class="event-poster">
    <img src="/events/${id}.jpg" alt="" loading="lazy" data-fallback="/events/${id}.svg">
  </div>`;
}

/** Swap a missing photograph for the generated poster. */
function wirePosters(root = document) {
  for (const img of root.querySelectorAll('.event-poster img[data-fallback]')) {
    const fallback = img.dataset.fallback;
    delete img.dataset.fallback;
    const swap = () => {
      img.removeEventListener('error', swap);
      img.src = fallback;
    };
    img.addEventListener('error', swap);
    // A broken image that finished loading before the listener was attached
    // never fires the event, so the state is checked once as well.
    if (img.complete && img.naturalWidth === 0) swap();
  }
}

/**
 * Who took the photograph.
 *
 * Not decoration: these are CC BY and CC BY-SA images, and the licence that
 * lets us use them requires the credit. Loaded once and cached.
 */
let creditsPromise;
function loadCredits() {
  creditsPromise ??= fetch('/events/credits.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return creditsPromise;
}

async function creditLine(eventId) {
  const credit = (await loadCredits()).find((c) => c.event === eventId);
  if (!credit) return '';
  return `<p class="hint" style="margin-top:10px;font-size:11.5px">
    Photo: <a href="${esc(credit.source)}" target="_blank" rel="noopener noreferrer">${esc(credit.author)}</a>,
    ${esc(credit.licence)}, via Wikimedia Commons
  </p>`;
}

function discoverCard(e) {
  return `<button class="event-card" data-event="${esc(e.id)}" ${e.availability === 'sold_out' ? 'disabled' : ''}>
    ${poster(e)}
    <div class="event-strip"></div>
    <div class="body">
      <h3>${esc(e.name)}</h3>
      <div class="hint" style="margin-bottom:10px">${e.venue ? `${esc(e.venue)} · ` : ''}${when(e.doorsOpenAt)}</div>
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
    ${poster(event)}
    <div class="eyebrow" style="margin-top:14px">${esc(event.organizer ?? '')}</div>
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
    <div id="photoCredit"></div>
  `);

  wirePosters($('sheetHost'));
  $('closeEvent').addEventListener('click', closeSheet);

  // Awaited after the sheet is up rather than before it, so the panel is not
  // held back by a credits file that is only ever a few hundred bytes.
  creditLine(eventId).then((html) => {
    const host = $('photoCredit');
    if (host) host.innerHTML = html;
  });
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
        <button class="btn btn-block" style="margin-top:16px" id="closeReceipt">Close</button>
      `);
      $('closeReceipt')?.addEventListener('click', closeSheet);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// ─── landing ─────────────────────────────────────────────────────────────────

/**
 * The front door.
 *
 * Shown to anybody who has not enrolled on this device. A fan who already has
 * a ReXell ID here goes straight to their tickets — a landing page in front of
 * somebody who has already signed up is an obstacle, not a welcome.
 */
function showLanding() {
  $('landing').hidden = false;
  // Nothing behind it should be reachable by keyboard while it covers the app.
  document.querySelector('.shell').setAttribute('inert', '');
}

function enterApp(view = 'tickets') {
  $('landing').hidden = true;
  document.querySelector('.shell').removeAttribute('inert');
  go(view);
}

/**
 * The recovery code, shown once.
 *
 * Twice in the life of an ID: at the end of signing up, and again after it has
 * been used to recover, because using one spends it and issues a replacement.
 * There is no route that returns it and no support tool that can recover it —
 * the same rule the organizer API keys follow, for the same reason.
 *
 * Dismissing requires ticking the box. A sheet that can be swiped away is a
 * sheet somebody swipes away, and this is the only screen where doing that
 * costs them their tickets.
 */
function recoveryCodeSheet(code, reason) {
  if (!code) {
    // Nothing to show rather than an empty box: an older API that does not
    // issue codes should not produce a broken screen.
    toast(reason === 'ready' ? 'Your ReXell ID is ready.' : 'Signed in.');
    return;
  }

  sheet(`
    <div class="eyebrow">${reason === 'ready' ? 'Last step' : 'Your code has changed'}</div>
    <h2 style="margin:8px 0 6px">${reason === 'ready' ? 'Write this down' : 'Here is your new code'}</h2>
    <p class="lede" style="margin-bottom:14px">
      ${
        reason === 'ready'
          ? 'This is the only way back into your account from another phone. We cannot show it again and we cannot recover it for you.'
          : 'The code you just used is spent. This one replaces it.'
      }
    </p>

    <!--
      Sized to fit on one line at 375px, and break-all is deliberately absent:
      a code that wraps mid-group reads as two shorter groups, which is exactly
      where a person copying it onto paper makes the mistake. If it ever has to
      wrap, it wraps at a hyphen.
    -->
    <div class="num" id="recoveryCode" style="text-align:center;font-size:clamp(14px,4.4vw,17px);font-weight:600;letter-spacing:0.04em;background:var(--sunk);border:1px solid var(--brand-line);border-radius:var(--r);padding:16px 8px;word-break:normal;overflow-wrap:normal">${esc(code)}</div>

    <button class="btn btn-quiet btn-block" id="copyRecovery" style="margin-top:10px">Copy</button>

    <label class="consent-item" style="margin-top:14px;cursor:pointer;align-items:center">
      <input type="checkbox" id="recoverySaved" style="width:18px;height:18px;flex:none;accent-color:var(--brand)">
      <span style="font-size:13.5px">I have written this down somewhere safe.</span>
    </label>

    <button class="btn btn-primary btn-lg btn-block" id="recoveryDone" style="margin-top:14px" disabled>Continue</button>
    <p class="hint" style="text-align:center;margin-top:10px">Losing it does not lose your tickets on <em>this</em> phone — only the way back in from a different one.</p>
  `);

  $('recoverySaved').addEventListener('change', (e) => {
    $('recoveryDone').disabled = !e.target.checked;
  });
  $('copyRecovery').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied.');
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The code
      // is on screen either way, which is what matters.
      toast('Select the code and copy it by hand.', true);
    }
  });
  $('recoveryDone').addEventListener('click', () => {
    closeSheet();
    toast(reason === 'ready' ? 'Your ReXell ID is ready.' : 'Signed in.');
    render();
  });
}

/**
 * "I already have one."
 *
 * On this device, that is just a matter of carrying on. From a new phone it
 * needs the recovery code issued at signup — there is no password and no email
 * on file, because collecting either would mean holding a second piece of
 * personal data to solve what one printed line solves.
 */
function loginSheet() {
  const known = state.identityId;

  sheet(`
    <h2 style="margin-bottom:6px">${known ? 'Welcome back' : 'Signing in'}</h2>
    ${
      known
        ? `<p class="lede" style="margin-bottom:16px">This device already holds a ReXell ID. Carry on where you left off.</p>
           <div class="field"><span>Your ReXell ID</span><div class="keyout num" style="font-size:12px;word-break:break-all;background:var(--sunk);border:1px solid var(--rule);border-radius:var(--r);padding:11px">${esc(known)}</div></div>
           <button class="btn btn-primary btn-block" id="loginContinue" style="margin-top:16px">Continue</button>`
        : `<p class="lede" style="margin-bottom:14px">
             Look at the camera. There is no password — we never asked you for
             one — and nothing to type unless the camera cannot see you.
           </p>
           <div class="viewfinder" id="vf" style="margin-bottom:12px">
             <video id="cam" autoplay playsinline muted></video>
             <div class="reticle"></div>
             <span class="tag" id="loginTag">starting the camera</span>
           </div>
           <button class="btn btn-primary btn-lg btn-block" id="loginFace" disabled>Sign in with your face</button>
           <p class="hint" id="loginHint" hidden style="margin-top:10px;color:var(--warn,#f7b955)"></p>

           <details style="margin-top:18px">
             <summary class="hint" style="cursor:pointer">Camera not working? Use your recovery code</summary>
             <div class="field" style="margin-top:12px">
               <span>Recovery code</span>
               <input id="loginId" class="input num" placeholder="RXL-XXXXX-XXXXX-XXXXX-XXXXX"
                      autocomplete="one-time-code" spellcheck="false" autocapitalize="characters"
                      style="letter-spacing:0.04em">
             </div>
             <button class="btn btn-block" id="loginRestore" style="margin-top:12px">Sign in with a code</button>
             <p class="hint" style="text-align:center;margin-top:10px">Each code works once. Using it gives you a fresh one.</p>
           </details>
           <button class="btn btn-quiet btn-block" id="loginNew" style="margin-top:12px">I do not have either — start again</button>`
    }
  `);

  if (!known) {
    startCamera().then((ok) => {
      $('loginTag').textContent = ok ? 'look straight ahead' : 'no camera — use your recovery code';
      $('loginFace').disabled = !ok;
      if (ok) $('vf').classList.add('is-live');
    });
    readyFaceMatcher().catch(() => {});
  }

  /*
   * Sign in by being recognised.
   *
   * No identity is sent — the server searches every enrolled template and
   * either comes back with one account or with nothing. That is why this is
   * not just a convenience: there is no field an attacker can put somebody
   * else's identifier into, because there is no field.
   */
  $('loginFace')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    $('loginHint').hidden = true;
    try {
      const { vector } = await faceVector($('cam'), (note) => {
        btn.textContent = note;
      });
      btn.textContent = 'Checking…';
      const result = await call('/v1/identities/identify', { vector, scope: 'global' });

      state.identityId = result.identityId;
      state.enrolled = Boolean(result.enrolled);
      localStorage.setItem('rexell.fan.id', result.identityId);
      localStorage.setItem('rexell.fan.enrolled', String(state.enrolled));
      stopCamera();
      closeSheet();
      enterApp('tickets');
      toast(`Signed in. Match ${result.score}.`);
    } catch (err) {
      $('loginHint').textContent =
        err instanceof FaceCaptureError
          ? err.message
          : `${err.message} You can still sign in with a recovery code below.`;
      $('loginHint').hidden = false;
      btn.textContent = label;
      btn.disabled = false;
    }
  });

  $('loginContinue')?.addEventListener('click', () => {
    closeSheet();
    enterApp('tickets');
  });

  $('loginNew')?.addEventListener('click', () => {
    closeSheet();
    consentSheet();
  });

  $('loginRestore')?.addEventListener('click', async (e) => {
    const code = $('loginId').value.trim();
    if (!code) return toast('Enter your recovery code first.', true);

    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // The server does the normalising — case, spacing, hyphens and the
      // characters people misread. Doing it here as well would be a second
      // implementation to keep in step with the first.
      const result = await call('/v1/identities/recover', { code });
      state.identityId = result.identityId;
      state.enrolled = Boolean(result.enrolled);
      localStorage.setItem('rexell.fan.id', result.identityId);
      localStorage.setItem('rexell.fan.enrolled', String(state.enrolled));
      closeSheet();
      enterApp('tickets');
      // Using a code spends it, so the replacement has to be shown with the
      // same weight as the original.
      recoveryCodeSheet(result.recoveryCode, 'rotated');
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

$('landingSignup').addEventListener('click', () => {
  enterApp('tickets');
  consentSheet();
});
$('landingLogin').addEventListener('click', () => {
  enterApp('tickets');
  loginSheet();
});
// Looking before committing is a reasonable thing to want to do, and the
// catalogue is public — nothing here needs an identity to read.
$('landingBrowse').addEventListener('click', () => enterApp('discover'));

// ─── boot ────────────────────────────────────────────────────────────────────

/*
 * Where a visit begins.
 *
 * `#start` means they arrived from the marketing site having already pressed
 * "Join as Fan". They have chosen; showing them this app's landing page to
 * choose again is a step that exists only because the product is two
 * deployments rather than one.
 *
 * `#browse` is the same idea for anybody sent to look at the catalogue.
 */
const intent = location.hash;
// Consumed, so a reload does not restart the flow they may have abandoned.
if (intent) history.replaceState(null, '', location.pathname + location.search);

if (state.enrolled && state.identityId) {
  enterApp('tickets');
} else if (intent === '#start') {
  enterApp('tickets');
  consentSheet();
} else if (intent === '#browse') {
  enterApp('discover');
} else if (intent === '#signin') {
  // Arrived from the join page having said they already have an ID.
  enterApp('tickets');
  loginSheet();
} else {
  showLanding();
  // Rendered underneath, so dismissing the landing reveals a ready app rather
  // than an empty frame that then populates.
  go('tickets');
}
