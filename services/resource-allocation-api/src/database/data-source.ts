import { DataSource } from 'typeorm';
import {
  createResourceAllocationDataSourceOptions,
  getResourceAllocationDatabaseUrl,
  RESOURCE_ALLOCATION_DATABASE_URL_ENV,
} from './database-options';

const databaseUrl = getResourceAllocationDatabaseUrl();
if (!databaseUrl) {
  throw new Error(`Set ${RESOURCE_ALLOCATION_DATABASE_URL_ENV} before running database migrations or preparation.`);
}

export const ResourceAllocationDataSource = new DataSource(
  createResourceAllocationDataSourceOptions(databaseUrl),
);
