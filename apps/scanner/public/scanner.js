/**
 * ReXell gate scanner.
 *
 * Provisioned from a link the organizer console builds: it registers this
 * device as a lane, pulls the sealed manifest, and asks for the key that opens
 * it — refused until two hours before doors, so a device taken a week early
 * carries a blob and nothing else.
 *
 * A browser port of `packages/gate`. The decision logic below is the same
 * algorithm as `GateEngine` — cosine 1:N against the opened manifest, then the
 * policy ladder — deliberately kept side by side with it so a change to one is
 * visibly a change to the other.
 *
 * The embedder is real, and is the same one the fan app enrolled with:
 * `/face-capture.js`, shared from @rexell/ui precisely so that the probe taken
 * here and the template taken there cannot drift into different vector spaces.
 *
 * Liveness is checked here too, and the lane picks the movement itself. At
 * signup that verdict has to be reached on a server, because the browser belongs
 * to the person being checked; here the browser belongs to the venue and the
 * attacker is whoever is standing in front of it. That flip is what lets the
 * check work with the network off.
 *
 * ⚠ It stops a photograph. It does not stop a video played on a phone held up to
 * the lens, and it does not stop a mask. It is motion, not presentation-attack
 * detection, and a venue that needs the latter still needs a certified sensor.
 */
import { faceVector, captureAtGate, readyFaceMatcher, FaceCaptureError } from '/face-capture.js';

const $ = (id) => document.getElementById(id);
const VECTOR_DIMS = 128;
// Measured, not guessed. Kept in step with PROTOTYPE_THRESHOLDS in
// packages/biometrics — the lane and the server must agree on what a match is.
const THRESHOLDS = { match: 0.6, review: 0.5 };
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
  // Attestations the server refused. Never zero quietly: a lane that cannot
  // file its evidence has to say so on the screen the operator is watching.
  refused: 0,
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

// ─── the decision, mirroring packages/gate/src/engine.ts ─────────────────────

function decide(probe, now, liveness) {
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

  // The face is right and the lane could not satisfy itself anybody was there.
  // After the match, so a stranger hears "no match" rather than being told the
  // face was recognised — that is a fact about somebody else. And a fallback,
  // never a denial: from here a photograph and a person in bad light look the
  // same, and only the desk can tell them apart.
  if (liveness && !liveness.passed) {
    return { outcome: 'fallback', code: 'LIVENESS_FAILED', message: 'Ask them to look at the camera and move their head.', ...base };
  }

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
    // v2 adds the liveness line. Kept byte-for-byte in step with
    // canonicalAttestation in packages/gate — a disagreement here is a
    // signature the server cannot verify, on every scan of the night.
    'rexell-attestation-v2', a.scannerId, a.eventId, a.lane, a.ticketId, a.identityId,
    String(a.decidedAt), a.outcome, a.code, a.matchScore.toFixed(6),
    String(a.manifestSequence), a.offline ? '1' : '0',
    a.liveness ? a.liveness.kind + ':' + (a.liveness.passed ? 'pass' : 'fail') + ':' + a.liveness.frames : 'none',
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

      /*
       * What the server actually stored, not merely that it answered.
       *
       * This used to be `if (r.ok) splice(...)`. The upload endpoint replies
       * 202 with a per-record breakdown — it verifies each signature and names
       * the ones it refused — so a batch in which every single attestation was
       * rejected as BAD_SIGNATURE was a 202, and the lane cheerfully discarded
       * the entire night's evidence. Silently. The whole purpose of signing
       * these is that the night can be reconstructed afterwards, and the one
       * failure mode that destroys that was the one being ignored.
       */
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        const rejected = body.rejected ?? [];
        const kept = Number(body.inserted ?? 0) + Number(body.duplicates ?? 0);
        state.queued.splice(0, Math.min(batch.length, kept + rejected.length));

        if (rejected.length > 0) {
          // Retrying will not help — a signature does not become valid — so it
          // is counted and shown rather than looped on or thrown away quietly.
          state.refused += rejected.length;
          console.error(`${rejected.length} attestation(s) refused by the server`, rejected.slice(0, 3));
        }
      }
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
  if (state.refused > 0) {
    // Ahead of the staleness warning: a lane that cannot file its decisions has
    // a worse problem than a lane that is a few seconds behind.
    banner.textContent = `${state.refused} decision${state.refused === 1 ? '' : 's'} were refused by the server and are not in the record. Call the supervisor.`;
    banner.classList.add('show');
  } else if (behind > 0) {
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

/**
 * Something went wrong reading the frame, shown on the verdict panel.
 *
 * Deliberately NOT a verdict: it does not touch the counters, it does not
 * append an attestation, and it does not go in the log. A camera that saw
 * nobody has not refused anybody, and a lane whose deny count climbs every
 * time somebody stands too far back is a lane nobody will trust.
 */
function showNote(message) {
  const v = $('verdict');
  v.className = 'verdict show fallback';
  $('vTitle').textContent = 'AGAIN';
  $('vMessage').textContent = message;
  $('vDetail').textContent = 'not recorded';
  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => v.classList.remove('show'), 3500);
}

function record(d, score, elapsedMs, liveness) {
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
    ...(liveness ? { liveness: { kind: liveness.kind, passed: liveness.passed, frames: liveness.frames } } : {}),
    signature: '',
  };
  state.unsigned.push({ attestation, message: canonical(attestation) });

  showVerdict(d, elapsedMs);
  persist();
  render();
}

async function scanFrame() {
  const video = $('cam');
  const btn = $('scanBtn');
  const label = btn.textContent;
  btn.disabled = true;

  // The clock starts after the frame is read, not before. Loading the model is
  // a one-off on the first scan of a shift; including it in the first lane
  // timing would make the whole lane look slow for the rest of the night.
  try {
    if (video.videoWidth > 0) {
      await readyFaceMatcher((note) => {
        btn.textContent = note;
      });
      btn.textContent = label;

      /*
       * The lane picks the movement, not the server.
       *
       * At signup the browser belongs to the person being checked and cannot be
       * trusted with the verdict; here it belongs to the venue, and the attacker
       * is whoever is standing in front of it. That flip is what lets this work
       * with the network off — which it has to, because a lane that needs a
       * server to decide is a lane that stops when the venue's wifi does.
       */
      const started = performance.now();
      const { vector, liveness } = state.config.liveness === 'off'
        ? { ...(await faceVector(video)), liveness: undefined }
        : await captureAtGate(video, (note) => {
            $('vTitle').textContent = 'LOOK UP';
            $('vMessage').textContent = note;
            $('verdict').className = 'verdict show fallback';
          });

      const d = decide(vector, Date.now(), liveness);
      record(d, d.score ?? 0, performance.now() - started, liveness);
    } else {
      // No camera on this machine. A random vector is not a scan of anybody,
      // and it exists only so the queue, signing and upload paths can be
      // exercised — it will read as NO MATCH, which is the honest answer.
      const started = performance.now();
      const d = decide(normalise(Array.from({ length: VECTOR_DIMS }, () => Math.random() - 0.5)), Date.now());
      record(d, d.score ?? 0, performance.now() - started);
    }
  } catch (e) {
    // Nothing to compare against is not the same as a refusal, and must never
    // be recorded as one. The lane gets an instruction; the attestation log
    // gets nothing.
    showNote(e instanceof FaceCaptureError ? e.message : `Scan failed: ${e.message}`);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
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
        // Decisions made but not yet signed. Signing happens at sync time to
        // keep an async hop off the 800 ms scan path, which means that between
        // two syncs every decision this lane has made lives ONLY here. Leaving
        // them out — as this did — meant a device that restarted mid-event lost
        // every scan since its last upload, which is precisely the stretch an
        // offline lane exists to survive.
        unsigned: state.unsigned,
        manifest: { ...state.manifest, entries: state.manifest.entries.map((e) => ({ ...e, template: Array.from(e.template) })) },
        admitted: [...state.admitted],
        queued: state.queued,
        stats: state.stats,
        refused: state.refused,
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
    state.unsigned = s.unsigned ?? [];
    state.stats = s.stats ?? state.stats;
    state.refused = s.refused ?? 0;
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

  await loadManifest(cfg);
  history.replaceState(null, '', location.pathname);
  persist();
  return true;
}

/**
 * Fetch the sealed manifest and the key that opens it.
 *
 * Two calls on purpose, and the separation is the point: the blob can be pushed
 * to a device days early over any channel, and it is inert until doors. The key
 * is refused before a window that opens two hours before doors open, so a
 * scanner that is stolen a week out carries nothing.
 *
 * This used to fetch the OPEN manifest — which carries a `templateRef` and no
 * template, because templates do not leave the vault unsealed — and then invent
 * a vector per entry from the length of its ticket id. Every real face therefore
 * scored against nonsense and the lane could only ever answer NO MATCH. The UI,
 * the ladder, the signing and the queue were all real; the one thing it could
 * not do was recognise anybody.
 */
async function loadManifest(cfg) {
  const sealedRes = await fetch(`${cfg.apiBase}/v1/events/${cfg.eventId}/manifest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scannerId: cfg.scannerId }),
  });
  if (!sealedRes.ok) throw new Error(`Could not get a manifest (${sealedRes.status}).`);
  const issued = await sealedRes.json();
  // The blob arrives wrapped in its own accounting: how many credentials went
  // in, and how many ticket-holders had no template to include. The second
  // number is the one an operator needs — those people are not in this lane's
  // gallery and will be sent to the desk however well they behave.
  const sealed = issued.sealed;
  if (issued.missingTemplates > 0) {
    console.warn(`${issued.missingTemplates} ticket-holder(s) have no template and cannot be matched at this lane.`);
  }

  const keyRes = await fetch(`${cfg.apiBase}/v1/events/${cfg.eventId}/manifest/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scannerId: cfg.scannerId }),
  });
  if (!keyRes.ok) {
    const body = await keyRes.json().catch(() => ({}));
    if (body?.error?.code === 'TOO_EARLY') {
      const at = issued.keyReleasesAt ? new Date(issued.keyReleasesAt).toLocaleString() : 'doors';
      throw new Error(`The key for this lane is not released until ${at}.`);
    }
    throw new Error(`Could not get the manifest key (${keyRes.status}).`);
  }
  const { key } = await keyRes.json();

  state.manifest = await openSealed(sealed, key);
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * AES-256-GCM, the browser half of `openManifest` in packages/gate.
 *
 * Node hands back the tag separately; WebCrypto wants it appended to the
 * ciphertext. The additional authenticated data is the manifest's own identity,
 * so a blob re-labelled for a different lane or a later expiry fails to open
 * rather than opening into the wrong event.
 */
async function openSealed(sealed, keyBase64) {
  if (Date.now() >= sealed.expiresAt) throw new Error('This manifest has expired. The lane needs re-keying.');
  if (sealed.scannerId && sealed.scannerId !== state.config.scannerId) {
    throw new Error('This manifest was issued to a different lane.');
  }

  const key = await crypto.subtle.importKey('raw', b64(keyBase64), { name: 'AES-GCM' }, false, ['decrypt']);
  const ciphertext = b64(sealed.ciphertext);
  const tag = b64(sealed.tag);
  const joined = new Uint8Array(ciphertext.length + tag.length);
  joined.set(ciphertext);
  joined.set(tag, ciphertext.length);

  const aad = new TextEncoder().encode(
    `${sealed.eventId}|${sealed.scannerId}|${sealed.sequence}|${sealed.expiresAt}`,
  );

  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64(sealed.iv), additionalData: aad, tagLength: 128 },
      key,
      joined,
    );
  } catch {
    // Not a decoding hiccup. Either the key is wrong or the envelope was
    // edited, and both mean this blob is not the manifest it claims to be.
    throw new Error('This manifest did not open. It is not for this lane, or it has been tampered with.');
  }

  const entries = JSON.parse(new TextDecoder().decode(plain));
  return {
    eventId: sealed.eventId,
    sequence: sealed.sequence,
    expiresAt: sealed.expiresAt,
    entries: entries.map((e) => ({
      ticketId: e.t,
      identityId: e.i,
      tierId: e.r,
      seat: e.s ?? undefined,
      gates: e.g,
      admitFrom: e.f,
      admitUntil: e.u,
      revoked: e.v,
      // Templates travel as base64 float bytes rather than JSON numbers: a
      // 12,000-entry manifest of 128-float arrays is megabytes of decimal text.
      template: new Float32Array(b64(e.b).buffer),
    })),
  };
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
