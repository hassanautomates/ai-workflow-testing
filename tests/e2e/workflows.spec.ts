import { test } from '@playwright/test';
import { discoverWorkflows, httpFetch } from '../../harness/discover.ts';
import { driveCase } from '../../harness/driver.ts';
import { baseURL } from './base-url.ts';

// One test per published workflow per input case, generated from the live
// GET /api/workflows when this file loads. Playwright starts the app before
// loading specs, so the listing is available here. If the API fails or lists
// nothing, discoverWorkflows throws and the whole run fails: it can never
// pass by testing nothing.
const workflows = await discoverWorkflows(baseURL);

for (const workflow of workflows) {
  test.describe(workflow.id, () => {
    for (const testCase of workflow.cases) {
      test(testCase.name, async ({ page }) => {
        await driveCase(page, workflow, testCase, httpFetch(baseURL));
      });
    }
  });
}
