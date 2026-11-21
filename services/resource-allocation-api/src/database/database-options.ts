import { resolve } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceAllocationOperationReceipt } from '../administration/idempotency/resource-allocation-operation-receipt.entity';

export const RESOURCE_ALLOCATION_DATABASE_URL_ENV = 'RESOURCE_ALLOCATION_DATABASE_URL';

export function getResourceAllocationDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return environment[RESOURCE_ALLOCATION_DATABASE_URL_ENV]?.trim() || undefined;
}

export function createResourceAllocationDataSourceOptions(databaseUrl?: string): DataSourceOptions {
  return {
    type: 'postgres',
    ...(databaseUrl ? { url: databaseUrl } : {}),
    entities: [ResourcePerson, ResourceGroup, ResourceProfile, ResourceInitiative, ResourceAllocationOperationReceipt],
    migrations: [resolve(__dirname, 'migrations/*{.js,.ts}')],
    migrationsRun: false,
    synchronize: false,
  };
}
