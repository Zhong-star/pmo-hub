import { resolve } from 'node:path';

/**
 * Settings of the performance runner, read from the environment so the same measurement runs
 * against the kind router or any other local environment prepared with `prepare:volume`.
 */

const appRoot = resolve(import.meta.dirname, '../..');

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, received "${raw}".`);
  return value;
}

function text(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function optionalText(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

export const performanceSettings = {
  /** Origin that serves `/resource-allocation/` and `/api/resource-allocation/v1`. Default: kind router. */
  baseURL: text('RESOURCE_ALLOCATION_PERF_BASE_URL', 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  /** Repetitions per operation (and per cold and warm opening). */
  repetitions: positiveInteger('RESOURCE_ALLOCATION_PERF_REPETITIONS', 10),
  /** Optional Chromium executable; the Playwright-managed browser is used when unset. */
  chromiumExecutable: optionalText('RESOURCE_ALLOCATION_PERF_CHROMIUM_EXECUTABLE'),
  /** Free label for the environment, for example "kind" or "local". */
  environmentLabel: text('RESOURCE_ALLOCATION_PERF_ENVIRONMENT', 'unspecified'),
  /** Overrides the detected frontend build mode, for example "production image in kind". */
  buildMode: optionalText('RESOURCE_ALLOCATION_PERF_BUILD_MODE'),
  /** SHA of the deployed build when it differs from the runner checkout. */
  deployedSha: optionalText('RESOURCE_ALLOCATION_PERF_DEPLOYED_SHA'),
  /** Optional file with the `prepare:volume` output (the `VOLUME_DATASET_SUMMARY` line or its JSON). */
  volumeSummaryPath: optionalText('RESOURCE_ALLOCATION_PERF_VOLUME_SUMMARY'),
  /** Where samples and the report are written. */
  outputRoot: resolve(appRoot, text('RESOURCE_ALLOCATION_PERF_OUTPUT_DIR', 'performance-results')),
  identities: {
    admin: text('RESOURCE_ALLOCATION_PERF_ADMIN_ID', 'volume-admin'),
    leadership: text('RESOURCE_ALLOCATION_PERF_LEADERSHIP_ID', 'volume-manager-01'),
    user: text('RESOURCE_ALLOCATION_PERF_USER_ID', 'volume-user-0001'),
  },
  /** Longest wait for one sample before it counts as an error. */
  sampleTimeoutMs: positiveInteger('RESOURCE_ALLOCATION_PERF_SAMPLE_TIMEOUT_MS', 60_000),
  appRoot,
};

/** Directory of the current run, set by the global setup for every worker. */
export function runDirectory(): string {
  const directory = process.env.RESOURCE_ALLOCATION_PERF_RUN_DIR;
  if (!directory) throw new Error('RESOURCE_ALLOCATION_PERF_RUN_DIR is not set; run through playwright.performance.config.ts.');
  return directory;
}
