import { resolve } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceAllocationOperationReceipt } from '../administration/idempotency/resource-allocation-operation-receipt.entity';
import { ResourceSubmission } from '../submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../submissions/resource-submission-line.entity';
import { ResourceSubmissionEntry } from '../submissions/resource-submission-entry.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequestAudit } from '../requests/resource-request-audit.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceAllocation } from '../allocations/resource-allocation.entity';
import { ResourceAllocationHistory } from '../allocations/resource-allocation-history.entity';

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
    entities: [
      ResourcePerson,
      ResourceGroup,
      ResourceProfile,
      ResourceInitiative,
      ResourceAllocationOperationReceipt,
      ResourceSubmission,
      ResourceSubmissionLine,
      ResourceSubmissionEntry,
      ResourceRequest,
      ResourceRequestHistory,
      ResourceRequestAudit,
      ResourceAllocationNotification,
      ResourceAllocation,
      ResourceAllocationHistory,
    ],
    migrations: [resolve(__dirname, 'migrations/*{.js,.ts}')],
    migrationsRun: false,
    synchronize: false,
  };
}
