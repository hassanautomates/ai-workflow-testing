import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type EngineBugName, engineBugs } from '../app/engine/bugs.ts';
import { type Manifest, readManifests } from '../harness/manifest.ts';
import { fixturesDir } from '../harness/naive.ts';

// npm run prove [-- --runs N]
//
// Produces the numbers for the README, and nothing else does:
//   (a) the taint-aware suite N times (default 20), each with a random AI_SEED
//   (b) the naive baseline with the same seeds: a fixture-based suite recorded
//       once with its own seed, asserting every value exactly
//   (c) the suite once per ENGINE_BUG
// and writes reports/prove.md. Every figure in that file is computed here
// from Playwright's JSON reports and the coverage manifests.
//
// Exit code 0 only if (a) had no failures and every bug was caught.

const reportsDir = resolve('reports');
const proveDir = join(reportsDir, 'prove');
const proveReport = join(reportsDir, 'prove.md');
/** A port of its own, so a dev server on the default port doesn't get in the way. */
const port = process.env.PROVE_PORT ?? '3999';

function runsFromArgs(): number {
  const flag = process.argv.indexOf('--runs');
  const raw = flag >= 0 ? process.argv[flag + 1] : process.env.PROVE_RUNS;
  const runs = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error(`--runs must be a positive integer, got ${String(raw)}`);
  return runs;
}

/** Distinct random seeds, in the same range the app uses when AI_SEED is unset. */
function randomSeeds(count: number, avoid: ReadonlySet<string> = new Set()): string[] {
  const seeds = new Set<string>();
  while (seeds.size < count) {
    const seed = String(randomInt(1, 2 ** 31));
    if (!avoid.has(seed)) seeds.add(seed);
  }
  return [...seeds];
}

function git(...args: string[]): string {
  return spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
}

// --- running Playwright ---------------------------------------------------------

interface TestResult {
  /** "<spec file> › <describe> › <title>" (no describe outside one). */
  name: string;
  passed: boolean;
  annotations: Record<string, string>;
}

interface SuiteRun {
  label: string;
  seed: string;
  /** Playwright's own verdict: failed tests, or a failure before any test ran. */
  passed: boolean;
  tests: TestResult[];
  /** Errors outside any test, e.g. discovery failing at load time. */
  loadErrors: string[];
  manifests: Manifest[];
}

interface JsonTest {
  status: string;
  annotations?: { type: string; description?: string }[];
}
interface JsonSpec {
  title: string;
  tests: JsonTest[];
}
interface JsonSuite {
  title: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}
interface JsonReport {
  suites?: JsonSuite[];
  errors?: { message?: string }[];
}

function collect(suite: JsonSuite, describe: string[], into: TestResult[]): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      into.push({
        name: [...describe, spec.title].join(' › '),
        // "expected" is a pass; "unexpected" a failure; "flaky" can't happen with retries off.
        passed: test.status === 'expected',
        annotations: Object.fromEntries(
          (test.annotations ?? []).map((annotation) => [
            annotation.type,
            annotation.description ?? '',
          ]),
        ),
      });
    }
  }
  for (const child of suite.suites ?? []) collect(child, [...describe, child.title], into);
}

async function playwright(
  label: string,
  env: Record<string, string>,
  specs: string[] = [],
): Promise<SuiteRun> {
  const reportFile = join(proveDir, `${label}.json`);
  const result = spawnSync('npx', ['playwright', 'test', ...specs, '--reporter=json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // A fresh server per run, so AI_SEED / ENGINE_BUG / HARNESS_MODE apply.
      CI: '1',
      PORT: port,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      ...env,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  let report: JsonReport = {};
  try {
    report = JSON.parse(await readFile(reportFile, 'utf8')) as JsonReport;
  } catch {
    // No report at all: Playwright failed before running anything.
  }
  const tests: TestResult[] = [];
  // Top-level suites are spec files; their names lead each test's name, so the
  // report shows whether a generated test or a hand-written one caught a bug.
  for (const file of report.suites ?? []) collect(file, [file.title], tests);
  const loadErrors = (report.errors ?? []).map(
    (error) => (error.message ?? 'unknown error').split('\n')[0] ?? '',
  );
  if (tests.length === 0 && loadErrors.length === 0) {
    loadErrors.push(
      `no tests ran (exit ${String(result.status)}): ${result.stderr.split('\n')[0] ?? ''}`,
    );
  }
  return {
    label,
    seed: env.AI_SEED ?? '',
    passed: result.status === 0 && loadErrors.length === 0 && tests.every((test) => test.passed),
    tests,
    loadErrors,
    manifests: await readManifests(),
  };
}

const failedTests = (run: SuiteRun) =>
  run.tests.filter((test) => !test.passed).map((test) => test.name);
const passCount = (run: SuiteRun) => run.tests.filter((test) => test.passed).length;

function progress(run: SuiteRun): void {
  const verdict = run.passed ? 'PASS' : 'FAIL';
  console.log(
    `  ${run.label.padEnd(34)} ${verdict}  ${String(passCount(run))}/${String(run.tests.length)} tests` +
      (run.loadErrors.length > 0 ? `  load error: ${run.loadErrors.join('; ')}` : ''),
  );
}

// --- distributions from the coverage manifests ------------------------------------

/** How often each branch was taken where a condition read model output. */
function branchCounts(runs: readonly SuiteRun[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const manifest of runs.flatMap((run) => run.manifests)) {
    for (const screen of manifest.screens) {
      if (!screen.observedFrom) continue;
      for (const option of screen.observedFrom) {
        const key = `${manifest.workflow} › ${manifest.case} › screen ${String(screen.seq)} › ${option}`;
        counts.set(key, (counts.get(key) ?? 0) + (option === screen.screen ? 1 : 0));
      }
    }
  }
  return counts;
}

/** For each optional model field shown on a page: runs where it was present (shape-checked) vs absent (gap). */
function optionalCounts(
  runs: readonly SuiteRun[],
): Map<string, { present: number; absent: number }> {
  const counts = new Map<string, { present: number; absent: number }>();
  const bump = (key: string, which: 'present' | 'absent') => {
    const entry = counts.get(key) ?? { present: 0, absent: 0 };
    entry[which] += 1;
    counts.set(key, entry);
  };
  for (const manifest of runs.flatMap((run) => run.manifests)) {
    const where = (element: string) => `${manifest.workflow} › ${manifest.case} › ${element}`;
    for (const gap of manifest.gaps) {
      if (gap.reason.startsWith('optional model field')) bump(where(gap.element), 'absent');
    }
    for (const assertion of manifest.assertions) {
      if (assertion.kind === 'shape' && !assertion.rule.required)
        bump(where(assertion.element), 'present');
    }
  }
  return counts;
}

// --- the report -------------------------------------------------------------------

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

const code = (text: string) => `\`${text}\``;

interface BugRun {
  bug: EngineBugName;
  run: SuiteRun;
  /** The server reported this bug on /healthz, so it was really switched on. */
  confirmed: boolean;
}

function render(args: {
  started: Date;
  runs: number;
  fixtureSeed: string;
  taintAware: SuiteRun[];
  naive: SuiteRun[];
  bugs: BugRun[];
  bugSeed: string;
}): { markdown: string; ok: boolean } {
  const { taintAware, naive, bugs } = args;
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';
  const total = (runs: SuiteRun[], pick: (run: SuiteRun) => number) =>
    runs.reduce((sum, run) => sum + pick(run), 0);
  const runsPassed = (runs: SuiteRun[]) => runs.filter((run) => run.passed).length;
  const testsFailed = (runs: SuiteRun[]) =>
    total(runs, (run) => failedTests(run).length + run.loadErrors.length);
  const testsRun = (runs: SuiteRun[]) => total(runs, (run) => run.tests.length);
  const allCaught = bugs.every((bug) => bug.confirmed && failedTests(bug.run).length > 0);
  const ok = runsPassed(taintAware) === taintAware.length && allCaught;

  const naiveFailuresByTest = new Map<string, number>();
  for (const name of naive.flatMap(failedTests)) {
    naiveFailuresByTest.set(name, (naiveFailuresByTest.get(name) ?? 0) + 1);
  }

  const lines = [
    '# Proof run',
    '',
    `Generated by ${code('npm run prove')}. Every figure below is computed from Playwright's JSON reports`,
    'and the coverage manifests of this run; nothing is typed by hand. Rerun to regenerate.',
    '',
    ...table(
      ['', ''],
      [
        ['Date', args.started.toISOString()],
        ['Commit', `${code(commit)}${dirty ? ' (with uncommitted changes)' : ''}`],
        ['Node', process.version],
        ['Runs per suite (N)', String(args.runs)],
        ['Naive fixture recorded with', code(`AI_SEED=${args.fixtureSeed}`)],
      ],
    ),
    '',
    '## Results',
    '',
    ...table(
      ['Suite', 'Runs passed', 'Tests run', 'Tests failed'],
      [
        [
          '(a) taint-aware',
          `${String(runsPassed(taintAware))} / ${String(taintAware.length)}`,
          String(testsRun(taintAware)),
          String(testsFailed(taintAware)),
        ],
        [
          '(b) naive baseline',
          `${String(runsPassed(naive))} / ${String(naive.length)}`,
          String(testsRun(naive)),
          String(testsFailed(naive)),
        ],
      ],
    ),
    '',
    `(a) runs every e2e spec. (b) runs the generated workflow tests with ${code('HARNESS_MODE=naive')}:`,
    'model output is compared exactly against what was shown when the fixture was recorded,',
    'and model-driven branches must take the recorded route.',
    '',
    '### Per seed',
    '',
    ...table(
      ['Seed', '(a) taint-aware', '(b) naive'],
      taintAware.map((run, i) => {
        const baseline = naive[i];
        return [
          code(run.seed),
          `${run.passed ? 'pass' : 'FAIL'} (${String(passCount(run))}/${String(run.tests.length)})`,
          baseline
            ? `${baseline.passed ? 'pass' : 'fail'} (${String(passCount(baseline))}/${String(baseline.tests.length)})`
            : 'not run',
        ];
      }),
    ),
    '',
    '### Naive baseline failures by test',
    '',
    ...(naiveFailuresByTest.size === 0
      ? ['None.']
      : table(
          ['Test', `Failed in (of ${String(naive.length)} runs)`],
          [...naiveFailuresByTest.entries()].sort().map(([name, count]) => [name, String(count)]),
        )),
    '',
    '### Failures in (a)',
    '',
    ...(testsFailed(taintAware) === 0
      ? ['None.']
      : taintAware
          .filter((run) => !run.passed)
          .flatMap((run) =>
            [...failedTests(run), ...run.loadErrors].map((name) => `- ${code(run.seed)}: ${name}`),
          )),
    '',
    '## Branch distribution (a)',
    '',
    'Where a condition read model output, how often the app took each branch (observed routing).',
    '',
    ...table(
      ['Where', 'Branch', 'Taken'],
      [...branchCounts(taintAware).entries()].sort().map(([key, count]) => {
        const cut = key.lastIndexOf(' › ');
        return [
          key.slice(0, cut),
          code(key.slice(cut + 3)),
          `${String(count)} / ${String(taintAware.length)}`,
        ];
      }),
    ),
    '',
    '## Optional model fields (a)',
    '',
    'Optional fields shown on a page: present (shape-checked) or absent (recorded as a coverage gap).',
    '',
    ...table(
      ['Field', 'Present', 'Absent'],
      [...optionalCounts(taintAware).entries()]
        .sort()
        .map(([key, { present, absent }]) => [code(key), String(present), String(absent)]),
    ),
    '',
    '## (c) Injected bugs',
    '',
    `Each run uses ${code(`AI_SEED=${args.bugSeed}`)} (the first seed of (a)) with one ${code('ENGINE_BUG')}.`,
    '',
    ...table(
      ['ENGINE_BUG', 'Breaks', 'What goes wrong', 'Active', 'Caught', 'Failing tests'],
      bugs.map(({ bug, run, confirmed }) => {
        const failing = failedTests(run);
        return [
          code(bug),
          engineBugs[bug].target,
          engineBugs[bug].description,
          confirmed ? 'yes' : 'NO',
          confirmed && failing.length > 0 ? 'yes' : 'NO',
          failing.length > 0 ? failing.join('<br>') : 'none',
        ];
      }),
    ),
    '',
    '"Active" means the server reported the bug on /healthz during the run.',
    '',
    '## Expectations',
    '',
    `- (a) no failures across ${String(taintAware.length)} random seeds: **${runsPassed(taintAware) === taintAware.length ? 'met' : 'NOT met'}**`,
    `- every injected bug caught by at least one test: **${allCaught ? 'met' : 'NOT met'}**`,
    '',
  ];
  return { markdown: lines.join('\n'), ok };
}

// --- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = new Date();
  const runs = runsFromArgs();
  const seeds = randomSeeds(runs);
  const [fixtureSeed = ''] = randomSeeds(1, new Set(seeds));
  const bugSeed = seeds[0] ?? '';

  await rm(proveDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
  await mkdir(proveDir, { recursive: true });
  const workflowSpec = 'tests/e2e/workflows.spec.ts';

  console.log(`recording naive fixtures with AI_SEED=${fixtureSeed}`);
  const recording = await playwright(
    'naive-record',
    { AI_SEED: fixtureSeed, HARNESS_MODE: 'naive-record' },
    [workflowSpec],
  );
  progress(recording);
  if (!recording.passed)
    throw new Error('recording the naive fixtures failed; see reports/prove/naive-record.json');

  console.log(`(a) taint-aware suite, ${String(runs)} runs`);
  const taintAware: SuiteRun[] = [];
  for (const [i, seed] of seeds.entries()) {
    const run = await playwright(`a-${String(i + 1)}-seed-${seed}`, { AI_SEED: seed });
    progress(run);
    taintAware.push(run);
  }

  console.log(`(b) naive baseline, same ${String(runs)} seeds`);
  const naive: SuiteRun[] = [];
  for (const [i, seed] of seeds.entries()) {
    const run = await playwright(
      `b-${String(i + 1)}-seed-${seed}`,
      { AI_SEED: seed, HARNESS_MODE: 'naive' },
      [workflowSpec],
    );
    progress(run);
    naive.push(run);
  }

  console.log(`(c) one run per ENGINE_BUG, AI_SEED=${bugSeed}`);
  const bugs: BugRun[] = [];
  for (const bug of Object.keys(engineBugs) as EngineBugName[]) {
    const run = await playwright(`c-${bug}`, { AI_SEED: bugSeed, ENGINE_BUG: bug });
    progress(run);
    const confirmed = run.tests.some((test) => test.annotations.ENGINE_BUG === bug);
    bugs.push({ bug, run, confirmed });
  }

  const { markdown, ok } = render({ started, runs, fixtureSeed, taintAware, naive, bugs, bugSeed });
  await writeFile(proveReport, markdown);
  console.log(`\nwrote ${proveReport}: expectations ${ok ? 'met' : 'NOT met'}`);
  process.exitCode = ok ? 0 : 1;
}

await main();
