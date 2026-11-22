import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '5188';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/real/**/*.spec.ts',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `npm run dev --workspace @pmo-hub/resource-allocation -- --port ${port}`,
    url: `http://127.0.0.1:${port}/resource-allocation/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
