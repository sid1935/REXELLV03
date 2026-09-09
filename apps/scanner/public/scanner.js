/**
 * ReXell gate scanner.
 *
 * A browser port of `packages/gate`. The decision logic below is the same
 * algorithm as `GateEngine` — cosine 1:N against the opened manifest, then the
 * policy ladder — deliberately kept side by side with it so a change to one is
 * visibly a change to the other.
 *
 * Three things about this file are honest limitations rather than shortcuts to
 * be tidied later:
 *
 *  1. THE EMBEDDER IS A PLACEHOLDER. `embed()` hashes pixels into a vector. It
 *     recognises nothing. It exists so the plumbing — capture, decide, queue,
 *     sync, sign, upload — can be exercised end to end before a recognition SDK
 *     is licensed. Swapping it is one function, marked below.
 *  2. THERE IS NO LIVENESS HERE. A printed photo would pass. Presentation-attack
 *     detection comes with the commercial SDK.
 *  3. This must not be used at a real gate until 1 and 2 are replaced.
 */

const $ = (id) => document.getElementById(id);
const VECTOR_DIMS = 128;
const THRESHOLDS = { match: 0.78, review: 0.62 };
const SYNC_INTERVAL_MS = 5_000;

const state = {
  config: null, // { apiBase, eventId, scannerId, lane, gateGroup, allowReentry }
  manifest: null, // { eventId, sequence, expiresAt, entries: [...] }
  keyPair: null,
  admitted: new Set(),
  unsigned: [], // { attestation, message }
  queued: [], // signed, awaiting upload
  serverSequence: 0,
  online: navigator.onLine,
  stats: { admit: 0, deny: 0, fallback: 0 },
};

// ─── vectors ─────────────────────────────────────────────────────────────────

function normalise(values) {
  const v = new Float32Array(VECTOR_DIMS);
  let sum = 0;
  for (let i = 0; i < VECTOR_DIMS; i += 1) {
    v[i] = values[i] ?? 0;
    sum += v[i] * v[i];
  }
  const mag = Math.sqrt(sum) || 1;
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] /= mag;
  return v;
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIMS; i += 1) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

/**
 * ⚠ REPLACE ME.
 *
 * A real implementation runs a licensed face-recognition model over the frame
 * and returns its embedding. This one folds downsampled luminance into a vector:
 * deterministic, fast, and completely incapable of recognising a person. It is
 * here so everything around it can be tested.
 */
function embed(imageData) {
  const acc = new Float32Array(VECTOR_DIMS);
  const { data, width, height } = imageData;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      acc[(x * 31 + y * 17) % VECTOR_DIMS] += lum;
    }
  }
  return normalise(acc);
}

// ─── the decision, mirroring packages/gate/src/engine.ts ─────────────────────

function decide(probe, now) {
  if (!state.manifest) {
    return { outcome: 'fallback', code: 'NO_MANIFEST', message: 'This lane has no manifest. Call the supervisor.' };
  }
  if (now >= state.manifest.expiresAt) {
    return { outcome: 'fallback', code: 'MANIFEST_EXPIRED', message: 'This scanner needs re-keying.' };
  }

  let best = null;
  let bestScore = 0;
  for (const entry of state.manifest.entries) {
    const score = similarity(probe, entry.template);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  // Never a denial on a weak match. A false reject must cost somebody ninety
  // seconds at a desk, not their evening.
  if (!best || bestScore < THRESHOLDS.review) {
    return { outcome: 'fallback', code: 'NO_MATCH', message: 'No match. Try again, then the resolution desk.', score: bestScore };
  }
  if (bestScore < THRESHOLDS.match) {
    return { outcome: 'fallback', code: 'LOW_CONFIDENCE', message: 'Ask them to look straight at the camera.', score: bestScore, entry: best };
  }

  const base = { score: bestScore, entry: best };
  if (best.revoked) return { outcome: 'deny', code: 'CREDENTIAL_REVOKED', message: 'Resold or cancelled. It belongs to somebody else now.', ...base };
  if (best.gates.length && !best.gates.includes(state.config.gateGroup)) {
    return { outcome: 'deny', code: 'WRONG_GATE', message: `Wrong entrance. Direct them to ${best.gates.join(' or ')}.`, ...base };
  }
  if (now < best.admitFrom) return { outcome: 'deny', code: 'TOO_EARLY', message: 'Doors have not opened for this ticket.', ...base };
  if (now >= best.admitUntil) return { outcome: 'deny', code: 'TOO_LATE', message: 'Entry for this ticket has closed.', ...base };
  if (state.admitted.has(best.ticketId)) {
    return state.config.allowReentry
      ? { outcome: 'admit', code: 'REENTRY', message: 'Welcome back.', ...base }
      : { outcome: 'deny', code: 'ALREADY_ADMITTED', message: 'Already used to enter.', ...base };
  }
  return { outcome: 'admit', code: 'MATCHED', message: 'Welcome in.', ...base };
}

// ─── signing, deferred off the decision path ─────────────────────────────────

function canonical(a) {
  return [
    'rexell-attestation-v1', a.scannerId, a.eventId, a.lane, a.ticketId, a.identityId,
    String(a.decidedAt), a.outcome, a.code, a.matchScore.toFixed(6),
    String(a.manifestSequence), a.offline ? '1' : '0',
  ].join('\n');
}

async function ensureKeyPair() {
  if (state.keyPair) return state.keyPair;
  const stored = localStorage.getItem('rexell.deviceKey');
  if (stored) {
    const jwk = JSON.parse(stored);
    state.keyPair = {
      privateKey: await crypto.subtle.importKey('jwk', jwk.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
      publicJwk: jwk.pub,
    };
    return state.keyPair;
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  localStorage.setItem('rexell.deviceKey', JSON.stringify({ priv, pub }));
  state.keyPair = { privateKey: pair.privateKey, publicJwk: pub };
  return state.keyPair;
}

async function signPending() {
  if (state.unsigned.length === 0) return;
  const { privateKey } = await ensureKeyPair();
  const pending = state.unsigned.splice(0, state.unsigned.length);
  for (const item of pending) {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(item.message),
    );
    state.queued.push({ ...item.attestation, signature: btoa(String.fromCharCode(...new Uint8Array(sig))) });
  }
}

// ─── sync ────────────────────────────────────────────────────────────────────

async function sync() {
  if (!state.config) return;
  const { apiBase, eventId } = state.config;

  try {
    const since = state.manifest?.sequence ?? 0;
    const r = await fetch(`${apiBase}/v1/events/${eventId}/deltas?since=${since}`);
    if (!r.ok) throw new Error(String(r.status));
    const body = await r.json();
    state.serverSequence = body.serverSequence;
    applyDeltas(body.deltas);
    setOnline(true);
  } catch {
    // A failed sync is normal at a venue. The lane keeps deciding on what it has
    // and shows the operator how far behind it is.
    setOnline(false);
    return;
  }

  await signPending();
  if (state.queued.length > 0) {
    try {
      const batch = state.queued.slice(0, 200);
      const r = await fetch(`${apiBase}/v1/events/${eventId}/attestations/signed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attestations: batch }),
      });
      if (r.ok) state.queued.splice(0, batch.length);
    } catch {
      /* retried next tick */
    }
  }
  persist();
  render();
}

/** Strictly in sequence, stopping at a gap. Same rule as the engine. */
function applyDeltas(deltas) {
  if (!state.manifest || !deltas?.length) return;
  const ordered = [...deltas].sort((a, b) => a.seq - b.seq);
  let seq = state.manifest.sequence;
  for (const d of ordered) {
    if (d.seq <= seq) continue;
    if (d.seq !== seq + 1) break; // the missing one might be the revocation
    const entry = state.manifest.entries.find((e) => e.ticketId === d.ticketId);
    if (entry && (d.kind === 'revoke' || d.kind === 'rebind')) entry.revoked = true;
    seq = d.seq;
  }
  state.manifest.sequence = seq;
}

// ─── ui ──────────────────────────────────────────────────────────────────────

function setOnline(online) {
  state.online = online;
}

function render() {
  const behind = Math.max(0, state.serverSequence - (state.manifest?.sequence ?? 0));
  const total = state.stats.admit + state.stats.deny + state.stats.fallback;
  const queued = state.queued.length + state.unsigned.length;

  $('laneLabel').textContent = `LANE ${(state.config?.lane ?? '—').toUpperCase()}`;
  $('netPill').textContent = state.online ? 'online' : 'offline';
  $('netPill').className = `pill ${state.online ? 'ok' : 'warn'}`;
  $('syncPill').textContent = behind > 0 ? `seq ${state.manifest?.sequence ?? 0} · ${behind} behind` : `seq ${state.manifest?.sequence ?? 0}`;
  $('syncPill').className = `pill ${behind > 0 ? 'bad' : 'ok'}`;
  $('queuePill').textContent = `${queued} queued`;
  $('queuePill').className = `pill ${queued > 500 ? 'warn' : ''}`;

  $('sAdmit').textContent = state.stats.admit;
  $('sDeny').textContent = state.stats.deny;
  $('sFall').textContent = state.stats.fallback;
  $('sRate').textContent = total ? `${((state.stats.fallback / total) * 100).toFixed(1)}%` : '0%';

  const banner = $('banner');
  if (behind > 0) {
    banner.textContent = `This lane is ${behind} update${behind === 1 ? '' : 's'} behind. Resold tickets may still scan as valid.`;
    banner.classList.add('show');
  } else if (!state.manifest) {
    banner.textContent = 'No manifest loaded. Append ?config= to provision this lane.';
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

let verdictTimer;
function showVerdict(d, elapsedMs) {
  const v = $('verdict');
  const titles = { admit: d.code === 'REENTRY' ? 'WELCOME BACK' : 'COME IN', deny: 'STOP', fallback: 'CHECK' };
  v.className = `verdict show ${d.outcome}`;
  $('vTitle').textContent = titles[d.outcome];
  $('vMessage').textContent = d.message;
  $('vDetail').textContent = `${d.code} · ${(d.score ?? 0).toFixed(3)} · ${elapsedMs.toFixed(0)}ms`;

  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => v.classList.remove('show'), d.outcome === 'admit' ? 1200 : 3000);

  const line = document.createElement('div');
  const cls = d.outcome === 'admit' ? 'a' : d.outcome === 'deny' ? 'd' : 'f';
  line.innerHTML = `<span class="${cls}">${d.outcome.toUpperCase().padEnd(8)}</span><span>${d.code}</span><span>${elapsedMs.toFixed(0)}ms</span>`;
  $('log').prepend(line);
  while ($('log').childElementCount > 30) $('log').lastElementChild.remove();
}

// ─── scanning ────────────────────────────────────────────────────────────────

const canvas = document.createElement('canvas');
canvas.width = 160;
canvas.height = 160;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function record(d, score, elapsedMs) {
  state.stats[d.outcome] += 1;
  if (d.outcome === 'admit' && d.entry) state.admitted.add(d.entry.ticketId);

  const attestation = {
    scannerId: state.config.scannerId,
    eventId: state.config.eventId,
    lane: state.config.lane,
    ticketId: d.entry?.ticketId ?? 'unknown',
    identityId: d.entry?.identityId ?? 'unknown',
    decidedAt: Date.now(),
    outcome: d.outcome,
    code: d.code,
    matchScore: score,
    manifestSequence: state.manifest?.sequence ?? 0,
    offline: !state.online,
    signature: '',
  };
  state.unsigned.push({ attestation, message: canonical(attestation) });

  showVerdict(d, elapsedMs);
  persist();
  render();
}

function scanFrame() {
  const video = $('cam');
  const started = performance.now();
  let probe;
  if (video.videoWidth > 0) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    probe = embed(ctx.getImageData(0, 0, canvas.width, canvas.height));
  } else {
    probe = normalise(Array.from({ length: VECTOR_DIMS }, () => Math.random() - 0.5));
  }
  const d = decide(probe, Date.now());
  record(d, d.score ?? 0, performance.now() - started);
}

/** Present a known credential, so the flow can be walked without a model. */
function simulate() {
  if (!state.manifest?.entries.length) return;
  const entry = state.manifest.entries[Math.floor(Math.random() * state.manifest.entries.length)];
  const noisy = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) noisy[i] = entry.template[i] + (Math.random() - 0.5) * 0.03;
  const started = performance.now();
  const d = decide(normalise(noisy), Date.now());
  record(d, d.score ?? 0, performance.now() - started);
}

// ─── provisioning and persistence ────────────────────────────────────────────

function persist() {
  if (!state.manifest) return;
  try {
    localStorage.setItem(
      'rexell.gate',
      JSON.stringify({
        config: state.config,
        manifest: { ...state.manifest, entries: state.manifest.entries.map((e) => ({ ...e, template: Array.from(e.template) })) },
        admitted: [...state.admitted],
        queued: state.queued,
        stats: state.stats,
      }),
    );
  } catch {
    /* storage full; the queue is still in memory */
  }
}

function restore() {
  const raw = localStorage.getItem('rexell.gate');
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    state.config = s.config;
    state.manifest = { ...s.manifest, entries: s.manifest.entries.map((e) => ({ ...e, template: Float32Array.from(e.template) })) };
    state.admitted = new Set(s.admitted);
    state.queued = s.queued ?? [];
    state.stats = s.stats ?? state.stats;
    return true;
  } catch {
    return false;
  }
}

/**
 * Provision from `?config=<base64 json>`.
 *
 * A real deployment pushes this through mobile device management, along with a
 * sealed manifest and a key released at doors-open. This is the shape of that,
 * done by hand.
 */
async function provision() {
  const param = new URLSearchParams(location.search).get('config');
  if (!param) return restore();

  const cfg = JSON.parse(atob(param));
  state.config = cfg;

  const { publicJwk } = await ensureKeyPair();
  const spki = await crypto.subtle.exportKey(
    'spki',
    await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
  );
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(spki))).match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;

  await fetch(`${cfg.apiBase}/v1/scanners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scannerId: cfg.scannerId,
      eventId: cfg.eventId,
      lane: cfg.lane,
      gateGroup: cfg.gateGroup,
      publicKeyPem: pem,
    }),
  });

  // The manifest arrives sealed and is opened with a key released separately.
  // Here the dev server hands back an already-opened one; the sealed path is
  // exercised by `apps/api/test/gate-e2e.test.ts`.
  const r = await fetch(`${cfg.apiBase}/v1/events/${cfg.eventId}/manifest`);
  const body = await r.json();
  state.manifest = {
    eventId: body.eventId,
    sequence: body.sequence,
    expiresAt: body.expiresAt,
    entries: body.entries.map((e) => ({
      ...e,
      template: normalise(Array.from({ length: VECTOR_DIMS }, (_, i) => Math.sin(i * (e.ticketId.length + 1)))),
    })),
  };
  history.replaceState(null, '', location.pathname);
  persist();
  return true;
}

// ─── boot ────────────────────────────────────────────────────────────────────

$('scanBtn').addEventListener('click', scanFrame);
$('simBtn').addEventListener('click', simulate);
$('syncBtn').addEventListener('click', sync);
addEventListener('online', () => { setOnline(true); render(); });
addEventListener('offline', () => { setOnline(false); render(); });

(async () => {
  await provision();
  render();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 } });
    $('cam').srcObject = stream;
  } catch {
    $('cam').hidden = true;
    $('noCam').hidden = false;
  }

  setInterval(sync, SYNC_INTERVAL_MS);
  if (state.config) sync();
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
