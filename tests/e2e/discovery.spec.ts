import { expect, test } from '@playwright/test';
import { discoverWorkflows } from '../../harness/discover.ts';
import { baseURL } from './base-url.ts';

// refund-request ships with "published": false. The app must still serve it
// (it is a real workflow, just not released), but it must never be tested.

const draft = 'refund-request';

test('an unpublished workflow is still served by the app', async ({ page }) => {
  await page.goto(`/run/${draft}`);
  const main = page.locator('main[data-workflow-id]');
  await expect(main).toHaveAttribute('data-workflow-id', draft);
  await expect(main).toHaveAttribute('data-step-id', 'request');
});

test('an unpublished workflow is left out of the listing and of discovery', async ({ request }) => {
  const listed = (await (await request.get('/api/workflows')).json()) as { id: string }[];
  expect(listed.map((workflow) => workflow.id)).not.toContain(draft);

  const discovered = await discoverWorkflows(baseURL);
  expect(discovered.length).toBeGreaterThan(0);
  expect(discovered.map((workflow) => workflow.id)).not.toContain(draft);
});
