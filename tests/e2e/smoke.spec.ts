import { expect, test } from '@playwright/test';

// Placeholder until generated per-workflow tests arrive in Milestone 3.
test('app answers its health check', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ ok: true });
});
