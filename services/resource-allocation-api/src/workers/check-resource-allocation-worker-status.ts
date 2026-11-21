import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createResourceAllocationDataSourceOptions, getResourceAllocationDatabaseUrl, RESOURCE_ALLOCATION_DATABASE_URL_ENV } from '../database/database-options';
import { readResourceAllocationWorkerStatus, safeWorkerErrorCode } from './resource-allocation-worker-health';

async function main(): Promise<void> {
  const databaseUrl = getResourceAllocationDatabaseUrl();
  if (!databaseUrl) throw new Error(`Set ${RESOURCE_ALLOCATION_DATABASE_URL_ENV} before checking worker status.`);

  const dataSource = new DataSource(createResourceAllocationDataSourceOptions(databaseUrl));
  await dataSource.initialize();
  try {
    const status = await readResourceAllocationWorkerStatus(dataSource);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (status.status !== 'healthy') process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Resource Allocation worker status could not be read: ${safeWorkerErrorCode(error)}\n`);
  process.exitCode = 1;
});
