/**
 * Liveness diagnostics — what the camera is actually measuring.
 *
 * This exists because "the liveness check does not respond to anything" is a
 * report nobody can act on, and the two people who could compare notes about it
 * were a developer with no camera and a user with no numbers. It shows the raw
 * measurements live: head pose, eye openness, the resting baseline every
 * movement is judged against, and how far through the requested movement you
 * currently are.
 *
 * It runs the SAME functions the fan app and the gate run — `faceGeometry` and
 * `movementProgress` out of `/face-capture.js` — so anything it shows is what
 * they see. A separate reimplementation here would diagnose a different program.
 *
 * A separate file rather than an inline script because the site's policy is
 * `script-src 'self'`, and an inline block would simply be blocked.
 */
import {
  readyFaceMatcher,
  faceGeometry,
  movementProgress,
  CHALLENGE_INSTRUCTIONS,
  ENROL_LIMITS,
  GATE_LIMITS,
} from '/face-capture.js';

const $ = (id) => document.getElementById(id);
const KINDS = ['turn_left', 'turn_right', 'nod', 'blink'];

const state = {
  running: false,
  kind: 'turn_left',
  limits: ENROL_LIMITS,
  frames: [],
  fps: [],
  best: 0,
};

function bar(el, value, min, max) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  el.style.width = pct + '%';
}

function setStatus(text, tone = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + tone;
}

async function run() {
  setStatus('Loading the model — about 8 MB, once.', 'busy');
  let faceapi;
  try {
    faceapi = await readyFaceMatcher((note) => setStatus(note, 'busy'));
  } catch (e) {
    setStatus('The matcher failed to load: ' + e.message, 'bad');
    return;
  }

  setStatus('Asking for the camera…', 'busy');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 } });
  } catch (e) {
    setStatus('No camera: ' + e.name + '. Liveness cannot be diagnosed without one.', 'bad');
    return;
  }
  const video = $('cam');
  video.srcObject = stream;
  await video.play().catch(() => {});

  state.running = true;
  $('startBtn').textContent = 'Restart';
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 });

  while (state.running) {
    const t0 = performance.now();
    let found;
    try {
      found = await faceapi.detectAllFaces(video, detector).withFaceLandmarks(true);
    } catch (e) {
      setStatus('Detection threw: ' + e.message, 'bad');
      break;
    }
    const elapsed = performance.now() - t0;
    state.fps.push(elapsed);
    if (state.fps.length > 20) state.fps.shift();
    const mean = state.fps.reduce((a, b) => a + b, 0) / state.fps.length;
    $('fps').textContent = `${mean.toFixed(0)} ms/frame · ${(1000 / mean).toFixed(1)} fps`;

    if (found.length !== 1) {
      setStatus(found.length === 0 ? 'No face found in the frame.' : `${found.length} faces in the frame.`, 'warn');
      $('faceSize').textContent = '—';
      continue;
    }

    const only = found[0];
    const box = only.detection.box;
    const size = Math.round(Math.min(box.width, box.height));
    $('faceSize').textContent = `${size}px ${size < 96 ? '— too small, move closer' : ''}`;
    $('score').textContent = only.detection.score.toFixed(3);

    const g = faceGeometry(only.landmarks);
    $('yaw').textContent = g.yaw.toFixed(3);
    $('pitch').textContent = g.pitch.toFixed(3);
    $('eye').textContent = g.eyeOpen.toFixed(3);
    bar($('yawBar'), g.yaw, -1, 1);
    bar($('pitchBar'), g.pitch, -1, 1);
    bar($('eyeBar'), g.eyeOpen, 0, 0.6);

    state.frames.push({ at: Date.now(), ...g });
    if (state.frames.length > 24) state.frames.splice(3, 1);

    const move = movementProgress(state.kind, state.frames, state.limits);
    if (move.base) {
      $('baseYaw').textContent = move.base.yaw.toFixed(3);
      $('basePitch').textContent = move.base.pitch.toFixed(3);
      $('baseEye').textContent = move.base.eye.toFixed(3);
    }
    state.best = Math.max(state.best, move.progress);
    bar($('progBar'), move.progress, 0, 1);
    $('progPct').textContent = Math.round(move.progress * 100) + '%';
    $('bestPct').textContent = Math.round(state.best * 100) + '%';

    if (move.done) {
      setStatus('SEEN — that would have passed.', 'good');
    } else if (state.frames.length < 3) {
      setStatus('Hold still for a moment while it takes your resting pose.', 'busy');
    } else {
      setStatus(CHALLENGE_INSTRUCTIONS[state.kind] + (move.progress > 0.15 ? ' — keep going' : ''), '');
    }
  }

  stream.getTracks().forEach((t) => t.stop());
}

function reset() {
  state.frames = [];
  state.best = 0;
  $('baseYaw').textContent = $('basePitch').textContent = $('baseEye').textContent = '—';
}

$('startBtn').addEventListener('click', () => {
  state.running = false;
  reset();
  setTimeout(run, 250);
});

$('resetBtn').addEventListener('click', reset);

for (const kind of KINDS) {
  const b = document.createElement('button');
  b.textContent = CHALLENGE_INSTRUCTIONS[kind];
  b.className = 'chip' + (kind === state.kind ? ' on' : '');
  b.addEventListener('click', () => {
    state.kind = kind;
    reset();
    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $('needs').textContent = describeTarget();
  });
  $('kinds').append(b);
}

$('surface').addEventListener('change', (e) => {
  state.limits = e.target.value === 'gate' ? GATE_LIMITS : ENROL_LIMITS;
  reset();
  $('needs').textContent = describeTarget();
});

function describeTarget() {
  const l = state.limits;
  if (state.kind === 'nod') return `pitch must travel ${l.nod} between its highest and lowest`;
  if (state.kind === 'blink') return `eye must close to ${l.blinkRatio}× your own resting value, then reopen`;
  const dir = state.kind === 'turn_left' ? 'rise' : 'fall';
  return `yaw must ${dir} by ${l.turn} from your resting pose`;
}

$('needs').textContent = describeTarget();
setStatus('Press Start. Nothing leaves this page — no capture is uploaded anywhere.');
