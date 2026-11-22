import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '5175';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/real/**/*.spec.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `npm run dev --workspace @pmo-hub/resource-allocation -- --port ${port}`,
    url: `http://127.0.0.1:${port}/resource-allocation/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
