import { test } from '@playwright/test';
import { discoverWorkflows, httpFetch, readAiSeed } from '../../harness/discover.ts';
import { driveCase } from '../../harness/driver.ts';
import { CoverageRecorder } from '../../harness/manifest.ts';
import { baseURL } from './base-url.ts';

// One test per published workflow per input case, generated from the live
// GET /api/workflows when this file loads. Playwright starts the app before
// loading specs, so the listing is available here. If the API fails or lists
// nothing, discoverWorkflows throws and the whole run fails: it can never
// pass by testing nothing.
const workflows = await discoverWorkflows(baseURL);

// The seed the app's simulated model is using. Every test prints it and
// attaches it to the report; rerun with AI_SEED=<seed> to reproduce a failure.
const aiSeed = await readAiSeed(baseURL);

// Playwright requires a destructuring pattern here even when no fixtures are used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'AI_SEED', description: aiSeed });
  await testInfo.attach('AI_SEED', { body: aiSeed, contentType: 'text/plain' });
  console.log(`AI_SEED=${aiSeed} (reproduce with: AI_SEED=${aiSeed} npm run test:e2e)`);
});

for (const workflow of workflows) {
  test.describe(workflow.id, () => {
    for (const testCase of workflow.cases) {
      test(testCase.name, async ({ page }, testInfo) => {
        const record = new CoverageRecorder(workflow.id, testCase.name, aiSeed);
        let result: 'passed' | 'failed' = 'failed';
        try {
          await driveCase(page, workflow, testCase, httpFetch(baseURL), record);
          result = 'passed';
        } finally {
          // Written for failures too: the manifest shows how far the case got.
          const path = await record.write(result);
          await testInfo.attach('coverage-manifest', { path, contentType: 'application/json' });
        }
      });
    }
  });
}
