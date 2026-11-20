import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: process.env.GITHUB_ACTIONS
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.TATTOO_E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    browserName: 'chromium',
    launchOptions: process.env.TATTOO_E2E_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TATTOO_E2E_BROWSER_EXECUTABLE }
      : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
});
