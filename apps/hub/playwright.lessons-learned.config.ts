import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'lessons-learned.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
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
      command: 'npm run start --workspace @pmo-hub/lessons-learned-api',
      url: 'http://127.0.0.1:3002/api/lessons-learned/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace @pmo-hub/lessons-learned',
      url: 'http://127.0.0.1:5174/lessons-learned/',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace @pmo-hub/hub -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace @pmo-hub/hub -- --host 127.0.0.1 --port 5176 --strictPort',
      url: 'http://127.0.0.1:5176',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        LESSONS_LEARNED_API_TARGET: 'http://127.0.0.1:5198',
      },
    },
  ],
});
