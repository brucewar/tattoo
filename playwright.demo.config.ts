import { defineConfig } from '@playwright/test';

const base = process.env.TATTOO_PAGES_BASE ?? '/';
export default defineConfig({
  testDir: './tests/demo',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:4173${base}`,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.TATTOO_E2E_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TATTOO_E2E_BROWSER_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: 'npm run preview:demo',
    url: `http://127.0.0.1:4173${base}`,
    reuseExistingServer: false,
  },
});
