import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'access.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev --workspace @pmo-hub/resource-allocation',
    url: 'http://127.0.0.1:5175/resource-allocation/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
