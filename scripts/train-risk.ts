/**
 * Fit the onsale risk model and write it into the repo.
 *
 *   npm run train:risk
 *
 * The model is committed rather than fetched at boot, because a scorer that
 * downloads its weights has a network dependency on the hot path of an onsale,
 * and the one thing an onsale cannot tolerate is a new way to fail.
 *
 * ⚠ Trained on synthetic traffic from `packages/risk/src/traffic.ts`. What it
 * demonstrates is that the pipeline separates scripted from human behaviour
 * under the assumptions written there. Real labels are chargebacks, gate denials
 * and biometric dedupe links, and this must be refitted on them — repeatedly —
 * before it is pointed at a real onsale.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIX,
  INDISTINGUISHABLE,
  Scorer,
  calibrateBands,
  evaluate,
  extract,
  generateTraffic,
  toTrainingRows,
  train,
} from '@rexell/risk';
import type { Persona } from '@rexell/risk';

const OUT = fileURLToPath(new URL('../packages/risk/src/model.ts', import.meta.url));

// Separate seeds. Evaluating on the training set would report a number that
// means nothing and looks excellent.
const trainingSessions = generateTraffic(DEFAULT_MIX, 20_260_910);
const holdoutSessions = generateTraffic(DEFAULT_MIX, 777_001);

const model = train(toTrainingRows(trainingSessions), {
  rounds: 120,
  learningRate: 0.2,
  version: 'stumps-120-synthetic-v1',
});

// Calibrate on TRAINING humans, evaluate on held-out ones. Choosing the bands
// against the same fans you then report a false-positive rate for is the same
// mistake as evaluating on the training set, wearing a different hat.
const uncalibrated = new Scorer(model);
const bands = calibrateBands(
  uncalibrated,
  trainingSessions.filter((s) => s.persona === 'human').map((s) => extract(s.signals)),
  { blockRate: 0.005, throttleRate: 0.02, challengeRate: 0.05 },
);
const scorer = new Scorer(model, bands);

const holdout = holdoutSessions.map((s) => ({ features: extract(s.signals), label: s.label, persona: s.persona }));
const result = evaluate(scorer, holdout, bands);

console.log('  Bands, chosen from a false-positive budget rather than round numbers');
console.log(`    challenge >= ${bands.challenge.toFixed(4)}   throttle >= ${bands.throttle.toFixed(4)}   block >= ${bands.block.toFixed(4)}`);

console.log(`\n  Model ${model.version} — ${model.stumps.length} stumps, ${model.featureNames.length} features\n`);
console.log('  Held-out traffic');
console.log(`    bots stopped         ${(result.botBlockRate * 100).toFixed(1)}%  (${result.blockedBots}/${result.totalBots})`);
console.log(`    humans wrongly blocked ${(result.humanFalseBlockRate * 100).toFixed(2)}%  (${result.blockedHumans}/${result.totalHumans})`);
console.log(`    humans given friction  ${(result.humanFrictionRate * 100).toFixed(2)}%`);

console.log('\n  By persona');
for (const persona of ['human', 'naive_bot', 'evasive_bot', 'human_farm'] as Persona[]) {
  const rows = holdout.filter((r) => r.persona === persona);
  if (rows.length === 0) continue;
  const scores = rows.map((r) => scorer.scoreVector(r.features)).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] ?? 0;
  const stopped = rows.filter((r) => scorer.scoreVector(r.features) >= bands.throttle).length;
  console.log(
    `    ${persona.padEnd(12)} median score ${median.toFixed(3)}   stopped ${((stopped / rows.length) * 100).toFixed(1)}%`,
  );
}

// The exit criterion is about a scripted bot run. A paid human in a farm is not
// a scripted bot, and folding the two together would damn the behavioural model
// for failing at something behaviour cannot see. They are reported separately.
const scripted = holdout.filter((r) => r.persona === 'naive_bot' || r.persona === 'evasive_bot');
const scriptedStopped = scripted.filter((r) => scorer.scoreVector(r.features) >= bands.throttle).length;
const evasiveCount = holdout.filter((r) => r.persona === 'evasive_bot').length;
const ceiling = (scripted.length - evasiveCount * INDISTINGUISHABLE.evasive_bot) / scripted.length;

console.log(`\n  Scripted automation stopped  ${((scriptedStopped / scripted.length) * 100).toFixed(1)}%  (${scriptedStopped}/${scripted.length})`);
console.log(`    rough ceiling              ~${(ceiling * 100).toFixed(1)}%, since ${(INDISTINGUISHABLE.evasive_bot * 100).toFixed(0)}% of evasive bots`);
console.log(`                                are drawn as humans and cannot be told apart`);
console.log(`  Human farms stopped          ${((holdout.filter((r) => r.persona === 'human_farm' && scorer.scoreVector(r.features) >= bands.throttle).length / holdout.filter((r) => r.persona === 'human_farm').length) * 100).toFixed(1)}%  — behaviour cannot see them;`);
console.log(`                                the graph and the gate binding handle these`);

console.log('\n  Most-used features');
const usage = new Map<number, number>();
for (const s of model.stumps) usage.set(s.feature, (usage.get(s.feature) ?? 0) + 1);
[...usage.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .forEach(([f, n]) => console.log(`    ${(model.featureNames[f] ?? '?').padEnd(22)} ${n} stumps`));

const source = `import type { Model } from './scorer.js';

/**
 * GENERATED by \`npm run train:risk\`. Do not edit by hand.
 *
 * Fitted on synthetic traffic — see the warning in scripts/train-risk.ts. Held
 * out at training time: ${(result.botBlockRate * 100).toFixed(1)}% of automated sessions stopped,
 * ${(result.humanFalseBlockRate * 100).toFixed(2)}% of humans wrongly blocked.
 */
export const MODEL: Model = ${JSON.stringify(model, null, 2)} as const;

/** Chosen from a false-positive budget: block the top 0.5% of human scores. */
export const CALIBRATED_BANDS = ${JSON.stringify(bands, null, 2)} as const;
`;

writeFileSync(OUT, source);
console.log(`\n  written to packages/risk/src/model.ts\n`);
