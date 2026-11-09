import { defineConfig, devices } from '@playwright/test';
import { baseURL, port } from './tests/e2e/base-url.ts';

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  // Flakiness gets fixed at the cause, never hidden by retries (see CLAUDE.md).
  retries: 0,
  // Coverage manifests: cleared before the run, summarised after it.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run start',
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(port) },
  },
});
