import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createResourceAllocationDataSourceOptions, getResourceAllocationDatabaseUrl, RESOURCE_ALLOCATION_DATABASE_URL_ENV } from '../database/database-options';
import { ResourceAllocationSubmissionWorker } from './resource-allocation-submission.worker';

async function main() {
  const databaseUrl = getResourceAllocationDatabaseUrl();
  if (!databaseUrl) throw new Error(`Set ${RESOURCE_ALLOCATION_DATABASE_URL_ENV} before running the Resource Allocation worker.`);

  const dataSource = new DataSource(createResourceAllocationDataSourceOptions(databaseUrl));
  await dataSource.initialize();
  const worker = new ResourceAllocationSubmissionWorker(dataSource);
  const once = process.argv.includes('--once');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    if (once) {
      await worker.processBatch();
      return;
    }
    while (!stopping) {
      try {
        await worker.processBatch();
      } catch (error) {
        process.stderr.write(`Resource Allocation submission worker cycle failed: ${safeErrorName(error)}\n`);
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  } finally {
    await dataSource.destroy();
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

void main().catch((error: unknown) => {
  process.stderr.write(`Resource Allocation submission worker could not start: ${safeErrorName(error)}\n`);
  process.exitCode = 1;
});
