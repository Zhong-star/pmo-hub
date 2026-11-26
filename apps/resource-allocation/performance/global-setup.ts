import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performanceSettings } from './support/settings';

/** Creates the run directory; workers inherit its path through the environment. */
export default function globalSetup(): void {
  const startedAt = new Date().toISOString();
  const directory = join(performanceSettings.outputRoot, startedAt.replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  process.env.RESOURCE_ALLOCATION_PERF_RUN_DIR = directory;
  process.env.RESOURCE_ALLOCATION_PERF_STARTED_AT = startedAt;
}
