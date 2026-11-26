import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeasurementEnvironment } from './support/environment';
import { buildReport } from './support/report';
import { operations, readOperationRecord, readRunFile, type OperationRecord } from './support/results';
import { runDirectory } from './support/settings';
import type { VolumeReport } from './support/volumes';

/** Writes the Markdown report from whatever the run recorded, including failed operations. */
export default function globalTeardown(): void {
  const directory = runDirectory();
  const records = new Map<string, OperationRecord | null>(operations.map((operation) => [operation.id, readOperationRecord(directory, operation.id)]));
  const report = buildReport(
    { startedAt: process.env.RESOURCE_ALLOCATION_PERF_STARTED_AT ?? 'unknown', finishedAt: new Date().toISOString(), runDirectory: directory },
    readRunFile<MeasurementEnvironment>(directory, 'environment.json'),
    readRunFile<VolumeReport>(directory, 'volumes.json'),
    records,
  );
  const file = join(directory, 'report.md');
  writeFileSync(file, report);
  process.stdout.write(`\nPerformance report: ${file}\n`);
}
