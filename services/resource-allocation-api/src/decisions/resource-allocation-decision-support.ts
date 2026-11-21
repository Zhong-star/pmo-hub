import { Inject } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequest } from '../requests/resource-request.entity';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export abstract class ResourceAllocationDecisionSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    protected readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    protected readonly databaseConfigured: boolean,
  ) {}

  protected async lockRequest(manager: EntityManager, requestId: string): Promise<ResourceRequest> {
    const item = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :requestId AND request.removed_at IS NULL', { requestId })
      .getOne();
    if (!item) throw this.notFound('Request');
    return item;
  }

  protected async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before using Tech Resource Allocation.');
    }
    const localAuthEnabled = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'false' &&
      !(process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true');
    if (!localAuthEnabled) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    const builder = manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .where('person.local_user_id = :localUserId AND person.active = TRUE', { localUserId });
    if (manager.queryRunner?.isTransactionActive) builder.setLock('pessimistic_write');
    const actor = await builder.getOne();
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  protected requireVersion(item: ResourceRequest, expectedVersion: number): void {
    if (item.version !== expectedVersion) {
      throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before continuing.');
    }
  }

  protected requireState(item: ResourceRequest, allowed: string[], detail: string): void {
    if (!allowed.includes(item.decisionState)) {
      throw new ResourceAllocationException('REQUEST_DECISION_NOT_ALLOWED', 'Request decision is not allowed', 422, detail);
    }
  }

  protected async requireDeadlineNotPassed(manager: EntityManager, dueAt: Date, code: string, detail: string): Promise<void> {
    const rows = await manager.query('SELECT clock_timestamp() > $1::timestamptz AS passed', [dueAt]) as Array<{ passed: boolean }>;
    if (rows[0].passed) {
      throw new ResourceAllocationException(code, 'Request deadline passed', 422, detail);
    }
  }

  protected async currentTimestamp(manager: EntityManager): Promise<Date> {
    const rows = await manager.query('SELECT clock_timestamp() AS now') as Array<{ now: Date | string }>;
    return new Date(rows[0].now);
  }

  protected async recordHistory(
    manager: EntityManager,
    item: ResourceRequest,
    actor: ResourcePerson,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    reason: string,
    correlationId: string,
    occurredAt: Date,
  ): Promise<void> {
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: item.id,
      actorSnapshot: this.actorSnapshot(actor),
      action,
      afterSnapshot: { before, after, reason },
      correlationId,
      occurredAt,
    });
  }

  protected async recordSystemHistory(
    manager: EntityManager,
    item: ResourceRequest,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    reason: string,
    correlationId: string,
    occurredAt: Date,
  ): Promise<void> {
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: item.id,
      actorSnapshot: { displayName: 'Automatic process', role: 'SYSTEM' },
      action,
      afterSnapshot: { before, after, reason, automatic: true },
      correlationId,
      occurredAt,
    });
  }

  protected async activeAdminIds(manager: EntityManager): Promise<string[]> {
    const rows = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .select('person.id', 'id')
      .where('person.active = TRUE AND person.role = :role', { role: ResourceAllocationRole.Admin })
      .orderBy('person.id', 'ASC')
      .getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  protected async groupLeaderIds(manager: EntityManager, groupId: string | undefined): Promise<string[]> {
    if (!groupId) return [];
    const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: groupId, active: true } });
    if (!group) return [];
    const rows = await manager.query(`
      SELECT DISTINCT person.id
      FROM resource_people AS person
      WHERE person.active = TRUE AND (
        (person.role IN ($1, $2) AND person.group_id = $3::uuid)
        OR person.id = $4::uuid
        OR person.id = $5::uuid
      )
      ORDER BY person.id
    `, [ResourceAllocationRole.Moderator, ResourceAllocationRole.Admin, group.id, group.supervisorId, group.managerId]) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  protected async notifyRecipients(
    manager: EntityManager,
    recipientIds: string[],
    actorId: string | undefined,
    item: ResourceRequest,
    eventCode: string,
    title: string,
    message: string,
    occurredAt: Date,
  ): Promise<void> {
    const recipients = [...new Set(recipientIds)].filter((recipientId) => recipientId !== actorId);
    for (const recipientId of recipients) {
      await manager.query(`
        INSERT INTO resource_allocation_notifications (
          recipient_id, source_request_id, event_code, title, message, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (recipient_id, event_code, source_request_id) DO NOTHING
      `, [recipientId, item.id, eventCode, title, message, occurredAt]);
    }
  }

  protected normalizeReason(value: string, field: string): string {
    if (typeof value !== 'string') throw this.validationError(`${field} is required.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 2000) throw this.validationError(`${field} must contain between 1 and 2000 characters.`);
    return normalized;
  }

  protected toResponse(item: ResourceRequest) {
    return {
      id: item.id,
      requesterSnapshot: item.requesterSnapshot,
      requestedConditions: item.requestedConditions,
      approvedConditions: item.approvedConditions,
      decisionState: item.decisionState,
      revalidationOriginState: item.revalidationOriginState,
      revalidationDecisionStage: item.revalidationDecisionStage,
      receivedAt: item.receivedAt.toISOString(),
      stageEnteredAt: item.stageEnteredAt.toISOString(),
      expirationDueAt: item.expirationDueAt.toISOString(),
      version: item.version,
    };
  }

  protected snapshot(item: ResourceRequest): Record<string, unknown> {
    return {
      decisionState: item.decisionState,
      revalidationOriginState: item.revalidationOriginState,
      revalidationDecisionStage: item.revalidationDecisionStage,
      requestedConditions: item.requestedConditions,
      approvedConditions: item.approvedConditions,
      stageEnteredAt: item.stageEnteredAt.toISOString(),
      expirationDueAt: item.expirationDueAt.toISOString(),
      decisionResponseDueAt: item.decisionResponseDueAt?.toISOString() ?? null,
      version: item.version,
    };
  }

  protected actorSnapshot(actor: ResourcePerson) {
    return { personId: actor.id, displayName: actor.displayName, role: actor.role };
  }

  protected groupId(item: ResourceRequest): string | undefined {
    const value = item.requestedConditions.groupId;
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
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
