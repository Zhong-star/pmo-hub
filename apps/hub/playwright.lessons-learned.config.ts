import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const localProfilesFile = fileURLToPath(new URL('./e2e/fixtures/lessons-learned-local-users.json', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  testMatch: 'lessons-learned.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'npm run start --workspace @pmo-hub/hub-api',
      url: 'http://127.0.0.1:5197/api/hub/v1/status',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: '5197' },
    },
    {
      command: 'npm run start --workspace @pmo-hub/lessons-learned-api',
      url: 'http://127.0.0.1:5199/api/lessons-learned/v1/health',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: '5199',
        LESSONS_LEARNED_LOCAL_AUTH_ENABLED: 'true',
        LESSONS_LEARNED_LOCAL_USERS_FILE: localProfilesFile,
      },
    },
    {
      command: 'npm run dev --workspace @pmo-hub/lessons-learned -- --host 127.0.0.1 --port 5181 --strictPort',
      url: 'http://127.0.0.1:5181/lessons-learned/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace @pmo-hub/hub -- --host 127.0.0.1 --port 5180 --strictPort',
      url: 'http://127.0.0.1:5180',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        HUB_API_TARGET: 'http://127.0.0.1:5197',
        LESSONS_LEARNED_API_TARGET: 'http://127.0.0.1:5199',
        LESSONS_LEARNED_FRONTEND_TARGET: 'http://127.0.0.1:5181',
      },
    },
    {
      command: 'npm run dev --workspace @pmo-hub/hub -- --host 127.0.0.1 --port 5182 --strictPort',
      url: 'http://127.0.0.1:5182',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        HUB_API_TARGET: 'http://127.0.0.1:5197',
        LESSONS_LEARNED_API_TARGET: 'http://127.0.0.1:5198',
        LESSONS_LEARNED_FRONTEND_TARGET: 'http://127.0.0.1:5181',
      },
    },
  ],
});
