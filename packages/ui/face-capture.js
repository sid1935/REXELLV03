/**
 * The face matcher. One implementation, shared by the fan app and the gate.
 *
 * This is the function that used to be a placeholder in two places. Both
 * surfaces folded downsampled luminance into 128 numbers — deterministic, fast,
 * and incapable of recognising a person. Two photographs of the same face in
 * different light scored further apart than two different faces in the same
 * light, which is the exact opposite of what a matcher has to do.
 *
 * It now runs a real convolutional face-recognition network in the browser:
 * detect a face, find its 68 landmarks, align on them, and read out the
 * network's 128-dimension descriptor. Same person, different photograph, the
 * descriptors land close together; different people, far apart. That is the
 * whole claim, and `npm run face:calibrate` is how it was measured rather than
 * assumed.
 *
 * Liveness lives here too, in two flavours, because the two surfaces have
 * opposite trust models. `captureLiveness` is for signup, where this code runs
 * on the phone of the person being checked and therefore cannot be trusted with
 * the verdict — it gathers evidence for a server to judge. `captureAtGate` is
 * for a lane, where the device belongs to the venue and the attacker is whoever
 * is in front of it, so the lane picks its own challenge and reaches its own
 * verdict, offline.
 *
 * WARNING: both stop a photograph held up to the lens. Neither stops a video
 * played on a phone screen, a mask, or — at signup — a modified client that
 * fabricates the motion. This is challenge-response, not presentation-attack
 * detection, and a venue that needs the latter needs a certified sensor.
 *
 * Why it lives in @rexell/ui rather than in either app: the fan app's enrolment
 * and the gate's probe have to land in the SAME vector space. Two copies of an
 * embedder are two chances to drift apart, and the failure would be silent —
 * everybody simply stops matching themselves, and the logs show an honest low
 * score rather than a bug.
 *
 * Model: @vladmandic/face-api (MIT), a maintained fork of face-api.js. The
 * network is the dlib ResNet descriptor. Licence in face/LICENSE.face-api.txt.
 */

export const VECTOR_DIMS = 128;

/** Where the library and weights are served from, same path on every surface. */
const FACE_BASE = '/face';

/**
 * Why the face has to be reasonably large in frame.
 *
 * The descriptor is read from a 150x150 aligned crop. A face occupying 60 px of
 * the source is upscaled to fill it, and the network then reads mostly
 * interpolation. It still returns 128 confident-looking numbers — there is no
 * error, just a descriptor that matches nobody including its owner. Refusing
 * the capture is the only way that failure becomes visible.
 */
const MIN_FACE_PX = 96;
const MIN_DETECTION_SCORE = 0.55;

export class FaceCaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FaceCaptureError';
    this.code = code;
  }
}

let loading = null;

/** Load the library and the three networks. Idempotent; safe to call on every capture. */
export function readyFaceMatcher(onProgress = () => {}) {
  if (loading) return loading;
  loading = (async () => {
    onProgress('Loading the matcher...');
    await loadScript(FACE_BASE + '/face-api.js');
    const faceapi = globalThis.faceapi;
    if (!faceapi) throw new FaceCaptureError('MODEL_UNAVAILABLE', 'The face matcher failed to load.');

    // WebGL where it exists, plain CPU where it does not. The CPU path is
    // several times slower and still finishes inside a second, which matters:
    // a gate lane on a machine with no GPU should be slow, not broken.
    try {
      await faceapi.tf.setBackend('webgl');
      await faceapi.tf.ready();
    } catch {
      await faceapi.tf.setBackend('cpu');
      await faceapi.tf.ready();
    }

    onProgress('Loading the model...');
    const models = FACE_BASE + '/models';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(models),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(models),
      faceapi.nets.faceRecognitionNet.loadFromUri(models),
    ]);
    return faceapi;
  })().catch((e) => {
    // A failed load must not be cached, or one flaky network request breaks
    // capture for the rest of the session.
    loading = null;
    throw e;
  });
  return loading;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.faceapi) return resolve();
    const fail = () => reject(new FaceCaptureError('MODEL_UNAVAILABLE', 'The face matcher failed to load.'));
    const existing = document.querySelector('script[data-face-api]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', fail);
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.dataset.faceApi = 'true';
    el.addEventListener('load', () => resolve());
    el.addEventListener('error', fail);
    document.head.append(el);
  });
}

/**
 * Read one face from a video element, canvas or image.
 *
 * Returns `{ vector, quality }` where `vector` is a plain array of 128 numbers,
 * unit-normalised so that comparison is a dot product. Throws FaceCaptureError
 * with a code the caller can turn into an instruction — "move closer", "one
 * person at a time" — because "capture failed" tells somebody standing at a
 * gate nothing they can act on.
 */
export async function faceVector(source, onProgress = () => {}) {
  const faceapi = await readyFaceMatcher(onProgress);
  onProgress('Looking for a face...');

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: MIN_DETECTION_SCORE });
  const found = await faceapi.detectAllFaces(source, options).withFaceLandmarks(true).withFaceDescriptors();

  if (found.length === 0) {
    throw new FaceCaptureError('NO_FACE', 'No face in the frame. Look at the camera, with your face lit from the front.');
  }
  if (found.length > 1) {
    // Not a technicality. Enrolling with two faces in frame binds the ticket to
    // whichever the detector happened to rank first, and nobody finds out until
    // the wrong person is refused at the door.
    throw new FaceCaptureError('MANY_FACES', found.length + ' faces in the frame. One person at a time.');
  }

  const only = found[0];
  const box = only.detection.box;
  const size = Math.min(box.width, box.height);
  if (size < MIN_FACE_PX) {
    throw new FaceCaptureError('TOO_FAR', 'Move closer — your face needs to fill more of the frame.');
  }

  return {
    vector: unit(only.descriptor),
    // The network's output before centring and normalising.
    //
    // Only the calibration tool uses it, and it has to: MEAN_DESCRIPTOR is the
    // mean of the RAW descriptors, so a tool that recomputed it from `vector`
    // would be averaging vectors the mean had already been subtracted from and
    // would quietly produce a second, wrong mean. That is not hypothetical —
    // it happened, and it put the first set of thresholds 0.1 too low.
    raw: Array.from(only.descriptor),
    quality: {
      detectionScore: round(only.detection.score),
      faceWidth: Math.round(box.width),
      faceHeight: Math.round(box.height),
      // The fraction of the frame the face occupies. Recorded with an enrolment
      // so a template that turns out to match badly can be explained rather
      // than argued about.
      coverage: round(size / Math.min(sourceWidth(source), sourceHeight(source))),
    },
  };
}

// ─── liveness ────────────────────────────────────────────────────────────────

/**
 * What the person is asked to do, per challenge kind.
 *
 * The server picks which one, from bytes the client cannot predict. That is the
 * entire mechanism: a printed photograph cannot turn, and a video recorded in
 * advance cannot know which way it will be asked to.
 */
export const CHALLENGE_INSTRUCTIONS = {
  turn_left: 'Turn your head slowly to your left',
  turn_right: 'Turn your head slowly to your right',
  nod: 'Nod — look down, then back up',
  blink: 'Blink, slowly and deliberately',
};

/**
 * Head pose and eye openness, from the 68 landmarks.
 *
 * Deliberately geometry rather than another network: it is inspectable, it
 * costs nothing on top of the detection already being run, and a reviewer can
 * check it against a photograph by eye.
 *
 * ⚠ SIGN CONVENTION, and it is the thing most likely to be got backwards.
 * Everything here is measured in the raw image, which is NOT mirrored — the CSS
 * transform that flips a selfie preview does not affect the pixels the detector
 * reads. `yaw` is positive when the nose sits toward the right-hand side of the
 * image. A person turning their head to their own right rotates their nose
 * toward the image's left, so `turn_right` expects NEGATIVE yaw.
 *
 * If that is inverted, the failure is loud rather than silent: the browser
 * refuses to submit until the challenge is satisfied, so a sign error means
 * nobody can enrol. It cannot let somebody through.
 */
export function faceGeometry(landmarks) {
  const jaw = landmarks.getJawOutline();
  const nose = landmarks.getNose();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();

  const tip = nose[6] ?? nose[nose.length - 1];
  const edgeL = jaw[0];
  const edgeR = jaw[jaw.length - 1];

  // Normalised by the face's own width, so moving closer to the camera does
  // not read as turning.
  const toLeft = tip.x - edgeL.x;
  const toRight = edgeR.x - tip.x;
  const width = toLeft + toRight;
  const yaw = width > 0 ? clamp((toLeft - toRight) / width) : 0;

  // Pitch from where the nose tip sits between the eye line and the chin.
  // Looking down moves the tip up the face relative to both.
  //
  // The 0.40 is not arbitrary: measured across twenty photographs of five
  // people facing a camera, the tip sits about four tenths of the way down.
  // The first version used 0.45 and every frontal face read as -0.2, which
  // would have made "look down" easier to satisfy than "look up" for no reason
  // other than a mis-centred constant.
  const eyeY = (mean(leftEye.map((p) => p.y)) + mean(rightEye.map((p) => p.y))) / 2;
  const chinY = jaw[Math.floor(jaw.length / 2)].y;
  const span = chinY - eyeY;
  const pitch = span > 0 ? clamp(((tip.y - eyeY) / span - 0.4) * 4) : 0;

  return { yaw: round(yaw), pitch: round(pitch), eyeOpen: round((ear(leftEye) + ear(rightEye)) / 2) };
}

/**
 * Eye aspect ratio: how open an eye is, independent of how large it is on screen.
 *
 * The two vertical distances over the horizontal one. Around 0.3 open, near
 * zero shut.
 */
function ear(eye) {
  if (eye.length < 6) return 0;
  const [p1, p2, p3, p4, p5, p6] = eye;
  const wide = dist(p1, p4);
  if (!(wide > 0)) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * wide);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const clamp = (n) => Math.max(-1, Math.min(1, n));

/**
 * Run a liveness challenge against the live camera.
 *
 * Samples the video for up to `timeoutMs`, measuring pose on every frame, and
 * returns once the requested movement has actually been observed. What comes
 * back is evidence — the whole sequence, each frame with its pose and its own
 * descriptor — not a boolean. The server re-derives the verdict from it, because
 * a boolean computed here is a claim by whoever is running this code, and the
 * attacker we care about is running this code.
 *
 * The descriptors are the reason the sequence cannot simply be fabricated by
 * splicing: the server checks every frame is the same person, and that no two
 * frames are the same capture submitted twice.
 */
export async function captureLiveness(source, challenge, onProgress = () => {}, options = {}) {
  const { timeoutMs = 12_000, maxFrames = 24, minFrames = 8, minSpanMs = 1200 } = options;
  const faceapi = await readyFaceMatcher(onProgress);
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: MIN_DETECTION_SCORE });

  const instruction = CHALLENGE_INSTRUCTIONS[challenge.kind] ?? 'Look at the camera';
  const frames = [];
  const scores = [];
  const started = Date.now();
  let sawCentre = false;
  let lastError;

  while (Date.now() - started < timeoutMs) {
    const found = await faceapi.detectAllFaces(source, detector).withFaceLandmarks(true).withFaceDescriptors();

    if (found.length !== 1) {
      // Reported but not recorded. A frame with nobody in it is not evidence of
      // anything, and a frame with two people in it is evidence of the wrong
      // thing.
      lastError = found.length === 0 ? 'Keep your face in the frame' : 'One person at a time';
      onProgress(lastError);
      continue;
    }

    const only = found[0];
    if (Math.min(only.detection.box.width, only.detection.box.height) < MIN_FACE_PX) {
      lastError = 'Move closer';
      onProgress(lastError);
      continue;
    }

    const geometry = faceGeometry(only.landmarks);
    frames.push({ at: Date.now() - started, ...geometry, vector: unit(only.descriptor) });
    if (frames.length > maxFrames) frames.shift();

    // The person has to be looking at the camera before the movement counts,
    // so that a photograph held at an angle from the start is not a completed
    // "turn".
    if (Math.abs(geometry.yaw) < 0.12 && Math.abs(geometry.pitch) < 0.3) sawCentre = true;

    onProgress(sawCentre ? instruction : 'Look straight at the camera');

    const span = frames.length ? frames[frames.length - 1].at - frames[0].at : 0;
    scores.push(only.detection.score);

    if (sawCentre && frames.length >= minFrames && span >= minSpanMs && satisfied(challenge.kind, frames)) {
      return {
        vector: pickEnrolmentFrame(frames).vector,
        // The mean detector confidence across the capture. A weak signal and
        // labelled as one: it says the frames looked like faces, not that they
        // looked like a live one. It is reported because the protocol carries
        // it, and derived rather than invented because a hard-coded 0.96 is a
        // number that tells nobody anything.
        passiveScore: round(mean(scores)),
        evidence: { kind: challenge.kind, frames: frames.map(strip) },
      };
    }
  }

  throw new FaceCaptureError(
    'LIVENESS_TIMEOUT',
    lastError ? `${lastError}, then ${instruction.toLowerCase()}.` : `${instruction}, and hold still between movements.`,
  );
}

/**
 * Has the requested movement been seen, locally?
 *
 * The same predicate the server applies, kept here so the browser stops asking
 * the moment it is satisfied. It is a convenience, never the control: the
 * server does not trust this and re-derives it from the frames.
 */
function satisfied(kind, frames) {
  const yaws = frames.map((f) => f.yaw);
  const pitches = frames.map((f) => f.pitch);
  const eyes = frames.map((f) => f.eyeOpen);
  if (kind === 'turn_left') return Math.max(...yaws) >= 0.28;
  if (kind === 'turn_right') return Math.min(...yaws) <= -0.28;
  if (kind === 'nod') return Math.max(...pitches) - Math.min(...pitches) >= 0.45;
  if (kind === 'blink') return Math.min(...eyes) <= 0.16 && Math.max(...eyes) >= 0.24;
  return false;
}

/**
 * Which frame becomes the template.
 *
 * The most front-on one, not the last or the most extreme: a descriptor read
 * from a turned head is a worse thing to be recognised by for the next twelve
 * months.
 */
function pickEnrolmentFrame(frames) {
  return frames.reduce((best, f) =>
    Math.abs(f.yaw) + Math.abs(f.pitch) < Math.abs(best.yaw) + Math.abs(best.pitch) ? f : best,
  );
}

const strip = (f) => ({ at: f.at, yaw: f.yaw, pitch: f.pitch, eyeOpen: f.eyeOpen, vector: f.vector });

/**
 * Liveness at a gate, which is a different problem from liveness at signup.
 *
 * The asymmetry is the whole design. At enrolment this code runs on the phone
 * of the person being checked, so it cannot be trusted and the verdict has to be
 * reached on a server from submitted evidence. At a gate it runs on the venue's
 * own device — the attacker is the person in front of the lens, not the person
 * running the browser — so the lane can pick its own challenge and judge its own
 * answer. That is what makes this work with the network off, which it has to:
 * a lane that needs a server to decide is a lane that stops when the venue's
 * wifi does.
 *
 * Two more differences from enrolment, both of them about a queue:
 *
 * It returns the moment it is satisfied rather than sampling a fixed window, so
 * a cooperative person costs a second rather than a fixed toll. And it accepts
 * far less movement — a glance, not a deliberate turn — because a lane that
 * makes four thousand people perform is a lane with a queue around the block.
 * The number is `GATE_TURN`, and it is lower than enrolment's on purpose.
 *
 * What it costs, measured rather than hoped: one pass of detection, landmarks
 * and descriptor is a median 135 ms on the WebGL backend, so the four frames
 * this needs at minimum are about 550 ms, and a real person reacting to the
 * prompt lands between one and one and a half seconds. A single-frame scan was
 * 135 ms. So liveness is roughly a tenfold increase in the capture, against a
 * decision that is 8 ms and unchanged — call it forty people a minute per lane
 * instead of a few hundred. For a twelve thousand capacity that is five lanes
 * for an hour of ingress rather than one, and an operator has to be told that
 * before the night rather than discover it during.
 *
 * ⚠ Same limit as everywhere else: this stops a photograph, not a video on a
 * phone screen held up to the lens, and not a mask. It is motion, not
 * presentation-attack detection.
 */
const GATE_TURN = 0.18;
const GATE_NOD = 0.3;

/**
 * Has the head moved, in the direction asked, relative to where it started?
 *
 * Relative, not absolute, and that was a bug worth catching. The first version
 * asked for an absolute yaw past a threshold after a frame near dead centre.
 * Measured across the calibration photographs, plenty of people face a camera
 * from a resting angle of 0.2 or more — so that rule could never be satisfied
 * by somebody whose neutral pose is slightly off-axis, no matter how far they
 * turned. It would have failed real ticket-holders for the shape of their neck.
 *
 * Anchoring on the first frame asks the question that was meant all along: did
 * this head turn, from wherever it happened to be.
 */
function gateSatisfied(kind, frames) {
  const yaws = frames.map((f) => f.yaw);
  const pitches = frames.map((f) => f.pitch);
  const eyes = frames.map((f) => f.eyeOpen);
  const from = yaws[0];
  if (kind === 'turn_left') return Math.max(...yaws) - from >= GATE_TURN;
  if (kind === 'turn_right') return from - Math.min(...yaws) >= GATE_TURN;
  if (kind === 'nod') return Math.max(...pitches) - Math.min(...pitches) >= GATE_NOD;
  if (kind === 'blink') return Math.min(...eyes) <= 0.16 && Math.max(...eyes) >= 0.24;
  return false;
}

/** Unpredictable per scan, from the platform CSPRNG rather than Math.random. */
export function pickGateChallenge() {
  const kinds = ['turn_left', 'turn_right', 'nod'];
  const [byte] = crypto.getRandomValues(new Uint8Array(1));
  // Blink is deliberately not in this list. At arm's length under venue
  // lighting the eye landmarks are the least reliable thing the model produces,
  // and a check that fails honest people in the dark is worse than one fewer
  // option to guess between.
  return kinds[byte % kinds.length];
}

/**
 * Watch until the person does something a photograph cannot.
 *
 * Returns `{ vector, liveness }` where `liveness.passed` says whether the
 * movement was seen. A failure is NOT an error: the caller still gets the best
 * vector it managed, because the lane needs to know both whether the face
 * matches AND whether it was live, and conflating them turns "we could not tell"
 * into "go away".
 */
export async function captureAtGate(source, onProgress = () => {}, options = {}) {
  const { timeoutMs = 4000, maxFrames = 20 } = options;
  const faceapi = await readyFaceMatcher(onProgress);
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: MIN_DETECTION_SCORE });

  const kind = pickGateChallenge();
  onProgress(CHALLENGE_INSTRUCTIONS[kind]);

  const started = Date.now();
  const frames = [];
  let best;

  while (Date.now() - started < timeoutMs) {
    const found = await faceapi.detectAllFaces(source, detector).withFaceLandmarks(true).withFaceDescriptors();
    if (found.length !== 1) continue;
    const only = found[0];
    if (Math.min(only.detection.box.width, only.detection.box.height) < MIN_FACE_PX) continue;

    const geometry = faceGeometry(only.landmarks);
    frames.push(geometry);
    if (frames.length > maxFrames) frames.shift();

    // The most front-on frame is the one worth matching against, and it is
    // usually not the one where they are mid-turn.
    if (!best || Math.abs(geometry.yaw) < Math.abs(best.yaw)) {
      best = { ...geometry, vector: unit(only.descriptor) };
    }
    if (frames.length >= 4 && gateSatisfied(kind, frames)) {
      return {
        vector: best.vector,
        liveness: { kind, passed: true, frames: frames.length, ms: Date.now() - started },
      };
    }
  }

  if (!best) throw new FaceCaptureError('NO_FACE', 'No face in the frame.');
  return {
    vector: best.vector,
    liveness: { kind, passed: false, frames: frames.length, ms: Date.now() - started },
  };
}

/** Cosine similarity of two unit vectors: the dot product. Same maths as the server. */
export function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIMS; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(-1, Math.min(1, dot));
}

/**
 * The average face, subtracted from every descriptor before comparison.
 *
 * Measured by `npm run face:calibrate`, and it is not a tuning knob — without
 * it the matcher barely works. Raw descriptors from this network all point into
 * a narrow cone: two strangers already score 0.83 cosine, two photographs of
 * the same person 0.95. The entire usable signal was the last two and a half
 * percent of the range, and the gap between the closest strangers (0.902) and
 * the least alike pair of the same person (0.927) was 0.025 — far too thin to
 * hang an admit/refuse decision on.
 *
 * Subtracting the component every face shares spends the whole range on the
 * part that differs. Same photographs, same network: strangers fall to -0.18
 * on average, same-person pairs rise to 0.58, and the gap becomes 0.27 — about
 * ten times wider.
 *
 * ⚠ This is 128 numbers averaged over 17 photographs of five people, so the
 * obvious objection is that it was fitted to the very faces it was measured on.
 * That was checked: recomputing the mean with each person held out and scoring
 * only that person keeps the two distributions cleanly apart in all five folds,
 * with margins from 0.28 to 0.56. It generalises to a face it has not seen.
 * A larger and more representative sample would still be better, and
 * `npm run face:calibrate` prints a replacement ready to paste.
 */
const MEAN_DESCRIPTOR = [
  -0.07262, 0.06707, 0.041979, -0.04381, -0.07099, -0.000321, -0.020468, -0.04908, 0.110127, -0.082384,
  0.118136, -0.008851, -0.180247, 0.02362, -0.017038, 0.114292, -0.124051, -0.084769, -0.089242, -0.062501,
  0.007009, 0.044522, 0.002308, 0.036287, -0.087014, -0.19659, -0.038685, -0.071041, -0.005677, -0.056211,
  -0.009977, 0.031688, -0.103315, -0.005917, 0.021544, 0.030484, -0.036327, -0.049084, 0.139542, 0.024574,
  -0.123522, 0.016946, 0.040366, 0.167627, 0.14814, 0.004257, 0.013412, -0.056128, 0.087772, -0.212411,
  0.010222, 0.10702, 0.055364, 0.069199, 0.051966, -0.124233, 0.017217, 0.081174, -0.117837, 0.038381,
  0.030441, -0.067525, -0.021132, -0.019896, 0.148262, 0.06784, -0.095281, -0.08519, 0.109717, -0.099081,
  -0.032492, 0.064063, -0.081278, -0.12808, -0.16403, 0.024731, 0.266749, 0.101666, -0.11128, 0.017264,
  -0.068116, -0.015975, 0.016243, 0.056679, -0.04129, -0.04011, -0.046289, 0.0231, 0.143474, -0.019558,
  -0.005273, 0.169285, 0.020872, -0.008455, 0.01027, 0.045491, -0.082216, -0.043396, -0.080997, -0.024386,
  -0.000437, -0.051675, -0.012027, 0.066537, -0.136625, 0.113018, -0.028353, -0.031911, -0.031288, -0.00802,
  -0.041308, 0.004805, 0.108683, -0.168944, 0.121469, 0.126966, 0.005469, 0.099028, 0.025628, 0.033666,
  -0.013514, -0.016234, -0.101405, -0.066816, 0.038306, -0.009204, 0.013763, 0.013233,
];

/**
 * Centre, then normalise.
 *
 * Both steps here rather than in each caller, because the fan app's enrolment
 * and the gate's probe have to be in one comparable space and a caller that
 * forgot the centring would produce vectors that match nothing — with no error
 * anywhere, just everybody failing to be themselves.
 */
function unit(descriptor) {
  const centred = Array.from(descriptor, (x, i) => x - (MEAN_DESCRIPTOR[i] ?? 0));
  let sum = 0;
  for (const x of centred) sum += x * x;
  const magnitude = Math.sqrt(sum);
  if (!(magnitude > 0)) throw new FaceCaptureError('NO_FACE', 'The capture produced nothing readable. Try again.');
  return centred.map((x) => x / magnitude);
}

const round = (n) => Math.round(n * 1000) / 1000;
const sourceWidth = (s) => s.videoWidth || s.naturalWidth || s.width || 1;
const sourceHeight = (s) => s.videoHeight || s.naturalHeight || s.height || 1;

/**
 * A short, readable rendering of a vector.
 *
 * The fan app shows this at enrolment, and it is not decoration: "we store a
 * mathematical template, not a photograph" is a claim, and showing the actual
 * numbers is the cheapest way to make it checkable. Full precision would be
 * unreadable, and would also put the template itself on the clipboard.
 */
export function vectorPreview(vector, shown = 8) {
  const head = Array.from(vector)
    .slice(0, shown)
    .map((x) => x.toFixed(4))
    .join(', ');
  return '[' + head + ', ... ' + (vector.length - shown) + ' more]';
}
