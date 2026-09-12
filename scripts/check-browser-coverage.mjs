/**
 * Did the browser suite actually run what it claims to?
 *
 * A Playwright project whose `testMatch` stops matching runs nothing and exits
 * zero, which is indistinguishable from passing. The camera project is the one
 * at risk: it is selected by filename, it is the only one that needs browser
 * flags, and its most important test — that an empty frame is refused rather
 * than turned into a vector — would simply stop running.
 *
 * So the report is read back and the floor asserted. The face tests are exempt:
 * they skip without a Y4M fixture, and CI has none by design.
 */
import { readFileSync } from 'node:fs';

const EXPECTED = { chromium: 27, camera: 5 };

const report = JSON.parse(readFileSync('playwright-report.json', 'utf8'));
const ran = {};

const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const project = test.projectName ?? 'unknown';
      const outcome = test.results?.at(-1)?.status ?? 'unknown';
      ran[project] ??= { passed: 0, skipped: 0, other: 0 };
      if (outcome === 'passed') ran[project].passed += 1;
      else if (outcome === 'skipped') ran[project].skipped += 1;
      else ran[project].other += 1;
    }
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);

let bad = false;
for (const [project, floor] of Object.entries(EXPECTED)) {
  const counts = ran[project];
  if (!counts) {
    console.error(`  ${project}: did not run at all`);
    bad = true;
    continue;
  }
  const ok = counts.passed >= floor;
  console.log(
    `  ${project.padEnd(9)} ${String(counts.passed).padStart(3)} passed, ${counts.skipped} skipped  ${ok ? 'ok' : `— expected at least ${floor}`}`,
  );
  if (!ok) bad = true;
}

process.exit(bad ? 1 : 0);
