import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'lessons-learned-unavailable.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'npm run start --workspace @pmo-hub/hub-api',
      url: 'http://127.0.0.1:3001/api/hub/v1/status',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace @pmo-hub/hub -- --host 127.0.0.1 --port 5175 --strictPort',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        LESSONS_LEARNED_FRONTEND_TARGET: 'http://127.0.0.1:5199',
      },
    },
  ],
});
