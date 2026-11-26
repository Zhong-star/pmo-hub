import { defineConfig, devices } from '@playwright/test';
import { performanceSettings } from './performance/support/settings';

/**
 * Release 1 performance runner. It is not part of CI: the other configurations only match `e2e/`,
 * and this one only matches `performance/*.perf.ts`. Point it at an environment prepared with
 * `prepare:volume` (see the README) through RESOURCE_ALLOCATION_PERF_BASE_URL.
 */
export default defineConfig({
  testDir: './performance',
  testMatch: '**/*.perf.ts',
  outputDir: './test-results/performance',
  globalSetup: './performance/global-setup.ts',
  globalTeardown: './performance/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30 * 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: performanceSettings.baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: performanceSettings.chromiumExecutable ? { executablePath: performanceSettings.chromiumExecutable } : {},
  },
});
