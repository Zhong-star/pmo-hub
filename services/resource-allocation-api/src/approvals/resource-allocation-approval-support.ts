import { Inject } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequest } from '../requests/resource-request.entity';

export abstract class ResourceAllocationApprovalSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    protected readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    protected readonly databaseConfigured: boolean,
  ) {}

  protected async lockCurrentRequest(manager: EntityManager, requestId: string): Promise<ResourceRequest> {
    const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :id AND request.removed_at IS NULL', { id: requestId })
      .getOne();
    if (!request) throw this.notFound('Request');
    return request;
  }

  protected requestSnapshot(request: ResourceRequest) {
    return {
      id: request.id,
      requesterId: request.requesterId,
      requesterSnapshot: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      decisionState: request.decisionState,
      revalidationOriginState: request.revalidationOriginState,
      revalidationDecisionStage: request.revalidationDecisionStage,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      decisionResponseDueAt: request.decisionResponseDueAt?.toISOString() ?? null,
      version: request.version,
    };
  }

  protected async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const localAuthEnabled = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'false' &&
      !(process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true');
    if (!localAuthEnabled) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before approving a request.');
    }
    const actor = await manager.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  protected actorSnapshot(person: ResourcePerson) {
    return { personId: person.id, displayName: person.displayName, role: person.role };
  }

  protected isValidDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  protected ineligibleReference(detail = 'The request must use an active person, group, ITDM, and profile that belong together.') {
    return new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, detail);
  }

  protected notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  protected validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  protected ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }
}
