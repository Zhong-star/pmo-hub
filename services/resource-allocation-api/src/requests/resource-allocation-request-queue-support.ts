import { Inject } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceRequest } from './resource-request.entity';
import { ResourceRequestHistory } from './resource-request-history.entity';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestSnapshot extends Record<string, unknown> {
  id: string;
  requesterId: string;
  requesterSnapshot: Record<string, unknown>;
  requestedConditions: Record<string, unknown>;
  approvedConditions: Record<string, unknown> | null;
  decisionState: string;
  receivedAt: Date;
  stageEnteredAt: Date;
  expirationDueAt: Date;
  removedAt: Date | null;
  version: number;
}

export abstract class ResourceAllocationRequestCommandSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    protected readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    protected readonly databaseConfigured: boolean,
  ) {}

  protected async lockRequest(manager: EntityManager, id: string): Promise<ResourceRequest> {
    const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :id', { id })
      .getOne();
    if (!request || request.removedAt) throw this.notFound('Request');
    return request;
  }

  protected async requireActiveReferences(manager: EntityManager, conditions: Record<string, unknown>) {
    const initiativeId = this.readUuid(conditions.initiativeId);
    const groupId = this.readUuid(conditions.groupId);
    const profileId = this.readUuid(conditions.resourceProfileId);
    if (!initiativeId || !groupId || !profileId) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The request references are incomplete.');
    }
    const initiative = await manager.getRepository(ResourceInitiative).findOne({ where: { id: initiativeId, active: true } });
    const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: groupId, active: true } });
    const profile = await manager.getRepository(ResourceProfile).findOne({ where: { id: profileId, active: true } });
    if (!initiative || !group || !profile || profile.groupId !== group.id) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The request must use an active ITDM, group, and profile from the same group.');
    }
    return { group, initiative, profile };
  }

  protected async notifyMany(
    manager: EntityManager,
    notices: Array<{
      recipientId: string;
      requestId: string;
      eventCode: string;
      title: string;
      message: string;
      createdAt: Date;
    }>,
  ): Promise<void> {
    if (notices.length === 0) return;
    const repository = manager.getRepository(ResourceAllocationNotification);
    await repository.insert(notices.map((notice) => repository.create({
      recipientId: notice.recipientId,
      sourceRequestId: notice.requestId,
      eventCode: notice.eventCode,
      title: notice.title,
      message: notice.message,
      createdAt: notice.createdAt,
    })));
  }

  protected async notify(
    manager: EntityManager,
    notice: { recipientId: string; requestId: string; eventCode: string; title: string; message: string; createdAt: Date },
  ): Promise<void> {
    await this.notifyMany(manager, [notice]);
  }

  protected async recordHistory(
    manager: EntityManager,
    request: ResourceRequest,
    actor: ResourcePerson,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    correlationId: string,
    occurredAt: Date,
    reason?: string,
  ): Promise<void> {
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: request.id,
      actorSnapshot: this.actorSnapshot(actor),
      action,
      afterSnapshot: { requestId: request.id, before, after, ...(reason ? { reason } : {}) },
      correlationId,
      occurredAt,
    });
  }

  protected snapshot(request: ResourceRequest): RequestSnapshot {
    return {
      id: request.id,
      requesterId: request.requesterId,
      requesterSnapshot: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      decisionState: request.decisionState,
      revalidationOriginState: request.revalidationOriginState,
      revalidationDecisionStage: request.revalidationDecisionStage,
      receivedAt: request.receivedAt,
      stageEnteredAt: request.stageEnteredAt,
      expirationDueAt: request.expirationDueAt,
      removedAt: request.removedAt,
      version: request.version,
    };
  }

  protected toRequestResponse(request: ResourceRequest) {
    return {
      id: request.id,
      requester: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      decisionState: request.decisionState,
      originState: request.revalidationOriginState,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      dueAt: request.decisionState === 'WAITING_FOR_PRESENTATION' ? request.expirationDueAt.toISOString() : null,
      version: request.version,
    };
  }

  protected async currentTimestamp(manager: EntityManager): Promise<Date> {
    const rows = await manager.query('SELECT clock_timestamp() AS occurred_at') as Array<{ occurred_at: Date }>;
    return rows[0].occurred_at;
  }

  protected async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    if (process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED === 'false' || process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true') {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before accessing request queues.');
    }
    const actor = await manager.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  protected async requireAdmin(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const actor = await this.requireActivePerson(manager, localUserId);
    if (actor.role !== ResourceAllocationRole.Admin) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Tech Resource Allocation Admin may perform this action.');
    }
    return actor;
  }

  protected ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  protected requireVersion(request: ResourceRequest, expected: number): void {
    if (request.version !== expected) {
      throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before continuing.');
    }
  }

  protected requireState(request: ResourceRequest, states: string[], detail: string): void {
    if (!states.includes(request.decisionState)) {
      throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request cannot be changed', 422, detail);
    }
  }

  protected async requireCurrentWaitingDeadline(manager: EntityManager, request: ResourceRequest): Promise<void> {
    const rows = await manager.query(
      'SELECT clock_timestamp() > $1::timestamptz AS expired',
      [request.expirationDueAt],
    ) as Array<{ expired: boolean }>;
    if (rows[0].expired) {
      throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request deadline passed', 422, 'The 21-day presentation deadline has passed. The request can no longer be changed.');
    }
  }

  protected normalizeReason(value: string): string {
    if (typeof value !== 'string') throw this.validationError('reason is required.');
    const reason = value.trim();
    if (!reason || reason.length > 2000) throw this.validationError('reason must contain between 1 and 2000 characters.');
    return reason;
  }

  protected readUuid(value: unknown): string | undefined {
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
  }

  protected actorSnapshot(actor: ResourcePerson) {
    return { personId: actor.id, displayName: actor.displayName, role: actor.role };
  }


  protected notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  protected validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

}
