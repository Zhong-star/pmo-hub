import { defineConfig, devices } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localProfilesTemplate = fileURLToPath(new URL('./e2e/fixtures/lessons-learned-local-users.json', import.meta.url));
let localProfilesFile = process.env.LESSONS_LEARNED_E2E_LOCAL_USERS_FILE;
if (!localProfilesFile) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-learned-e2e-'));
  localProfilesFile = join(fixtureDirectory, 'local-users.json');
  copyFileSync(localProfilesTemplate, localProfilesFile);
  process.env.LESSONS_LEARNED_E2E_LOCAL_USERS_FILE = localProfilesFile;
  process.on('exit', () => rmSync(fixtureDirectory, { recursive: true, force: true }));
}

export default defineConfig({
  testDir: './e2e',
  testMatch: ['lessons-learned.spec.ts', 'lessons-learned-responsive-nav.spec.ts'],
  workers: 1,
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
        ...(process.env.LESSONS_LEARNED_DATABASE_URL
          ? { LESSONS_LEARNED_DATABASE_URL: process.env.LESSONS_LEARNED_DATABASE_URL }
          : {}),
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
