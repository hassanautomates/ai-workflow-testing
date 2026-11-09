import { test } from '@playwright/test';
import { discoverWorkflows, httpFetch, readServerInfo } from '../../harness/discover.ts';
import { driveCase } from '../../harness/driver.ts';
import { CoverageRecorder } from '../../harness/manifest.ts';
import { Fixture, harnessMode } from '../../harness/naive.ts';
import { baseURL } from './base-url.ts';

// One test per published workflow per input case, generated from the live
// GET /api/workflows when this file loads. Playwright starts the app before
// loading specs, so the listing is available here. If the API fails or lists
// nothing, discoverWorkflows throws and the whole run fails: it can never
// pass by testing nothing.
const workflows = await discoverWorkflows(baseURL);

// The seed the app's simulated model is using. Every test prints it and
// attaches it to the report; rerun with AI_SEED=<seed> to reproduce a failure.
const { aiSeed, engineBug } = await readServerInfo(baseURL);

// "taint" unless npm run prove asks for the naive baseline (see harness/naive.ts).
const mode = harnessMode();

// Playwright requires a destructuring pattern here even when no fixtures are used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'AI_SEED', description: aiSeed });
  if (engineBug) testInfo.annotations.push({ type: 'ENGINE_BUG', description: engineBug });
  if (mode !== 'taint') testInfo.annotations.push({ type: 'HARNESS_MODE', description: mode });
  await testInfo.attach('AI_SEED', { body: aiSeed, contentType: 'text/plain' });
  console.log(`AI_SEED=${aiSeed} (reproduce with: AI_SEED=${aiSeed} npm run test:e2e)`);
});

for (const workflow of workflows) {
  test.describe(workflow.id, () => {
    for (const testCase of workflow.cases) {
      test(testCase.name, async ({ page }, testInfo) => {
        const record = new CoverageRecorder(workflow.id, testCase.name, aiSeed);
        const fixture =
          mode === 'naive'
            ? await Fixture.load(workflow.id, testCase.name)
            : mode === 'naive-record'
              ? Fixture.recording(workflow.id, testCase.name, aiSeed)
              : undefined;
        let result: 'passed' | 'failed' = 'failed';
        try {
          await driveCase(page, workflow, testCase, httpFetch(baseURL), record, fixture);
          result = 'passed';
          if (fixture?.mode === 'naive-record') await fixture.write();
        } finally {
          // Written for failures too: the manifest shows how far the case got.
          const path = await record.write(result);
          await testInfo.attach('coverage-manifest', { path, contentType: 'application/json' });
        }
      });
    }
  });
}
