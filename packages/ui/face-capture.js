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
 * WARNING: the one thing still missing is liveness. Nothing here can tell a
 * face from a photograph of a face, so a printed picture held to the camera
 * will enrol and will pass the gate. Presentation-attack detection is a
 * separate model and is the remaining blocker on using this at a real door.
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
