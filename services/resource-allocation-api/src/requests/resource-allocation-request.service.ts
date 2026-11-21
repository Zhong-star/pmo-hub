import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { markInitiativeUsedForRequest } from '../initiatives/mark-initiative-used';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { ResourceRequest, } from './resource-request.entity';
import { ResourceRequestAudit } from './resource-request-audit.entity';
import { ResourceRequestHistory } from './resource-request-history.entity';
import { ResourceRequestCategory, ResourceRequestDecisionState } from '../submissions/submission-category';
import { normalizeRequestedWeeklyHours } from './requested-weekly-hours';
import { removeResourceRequest } from './remove-resource-request';
import { getRequestRevalidationSummary } from './revalidate-requests-for-eligibility-change';
import { ResourceAllocation } from '../allocations/resource-allocation.entity';
import { allocationResponse } from '../allocations/allocation-response';
import type { RequestCollectionQueryDto, UpdateRequestedConditionsDto } from './request.dto';

const defaultPageSize = 50;
const maximumPageSize = 100;
const cursorVersion = 1;

interface RequestCursor {
  version: 1;
  receivedAt: string;
  id: string;
  filters: {
    initiativeId?: string;
    decisionState?: ResourceRequestDecisionState;
    groupId?: string;
    resourceProfileId?: string;
  };
}

interface AuditCursor {
  version: 1;
  occurredAt: string;
  id: string;
  requestId: string;
}

interface PageQuery {
  limit?: string | number;
  cursor?: string;
}

@Injectable()
export class ResourceAllocationRequestService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async list(localUserId: string | undefined, query: RequestCollectionQueryDto) {
    const actor = await this.requireActivePersonOutsideTransaction(localUserId);
    const filters = {
      ...(query.initiativeId ? { initiativeId: query.initiativeId.toLowerCase() } : {}),
      ...(query.decisionState ? { decisionState: query.decisionState } : {}),
      ...(query.groupId ? { groupId: query.groupId.toLowerCase() } : {}),
      ...(query.resourceProfileId ? { resourceProfileId: query.resourceProfileId.toLowerCase() } : {}),
    };
    const page = this.parsePage(query, filters);
    const builder = this.dataSource.getRepository(ResourceRequest).createQueryBuilder('request')
      .where('request.requester_id = :requesterId AND request.removed_at IS NULL', { requesterId: actor.id });
    if (filters.initiativeId) builder.andWhere("request.requested_conditions ->> 'initiativeId' = :initiativeId", { initiativeId: filters.initiativeId });
    if (filters.decisionState) builder.andWhere('request.decision_state = :decisionState', { decisionState: filters.decisionState });
    if (filters.groupId) builder.andWhere("request.requested_conditions ->> 'groupId' = :groupId", { groupId: filters.groupId });
    if (filters.resourceProfileId) builder.andWhere("request.requested_conditions ->> 'resourceProfileId' = :resourceProfileId", { resourceProfileId: filters.resourceProfileId });
    if (page.after) {
      builder.andWhere('(request.received_at, request.id) < (:receivedAt, :id)', {
        receivedAt: page.after.receivedAt,
        id: page.after.id,
      });
    }
    const found = await builder
      .orderBy('request.received_at', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .take(page.limit + 1)
      .getMany();
    const now = await this.databaseNow();
    const hasNext = found.length > page.limit;
    const items = found.slice(0, page.limit);
    const lastItem = items[items.length - 1];
    return {
      items: items.map((item) => this.toRequestResponse(item, now)),
      page: {
        nextCursor: hasNext && lastItem
          ? this.encodeCursor({
            version: cursorVersion,
            receivedAt: lastItem.receivedAt.toISOString(),
            id: lastItem.id,
            filters,
          })
          : null,
        limit: page.limit,
      },
    };
  }

  async get(localUserId: string | undefined, id: string) {
    const actor = await this.requireActivePersonOutsideTransaction(localUserId);
    const request = await this.dataSource.getRepository(ResourceRequest).createQueryBuilder('request')
      .where('request.id = :id AND request.requester_id = :requesterId AND request.removed_at IS NULL', { id, requesterId: actor.id })
      .getOne();
    if (!request) throw this.notFound('Request');
    const allocation = await this.dataSource.getRepository(ResourceAllocation).findOne({ where: { sourceRequestId: request.id } });
    const now = await this.databaseNow();
    return {
      request,
      allocation: allocation ? allocationResponse(allocation) : null,
      dueAt: this.actionableDeadline(request)?.toISOString() ?? null,
      availableActions: this.availableActions(request, now),
      revalidation: await getRequestRevalidationSummary(this.dataSource.manager, request),
    };
  }

  async update(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    correlationId: string | undefined,
    input: UpdateRequestedConditionsDto,
  ): Promise<ResourceRequest> {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correlation = this.requireCorrelationId(correlationId);
    const changes = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as UpdateRequestedConditionsDto;
    if (Object.keys(changes).length === 0) throw this.validationError('At least one requested condition is required.');

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const repository = manager.getRepository(ResourceRequest);
        const item = await repository.createQueryBuilder('request')
          .setLock('pessimistic_write')
          .where('request.id = :id AND request.requester_id = :requesterId AND request.removed_at IS NULL', { id, requesterId: actor.id })
          .getOne();
        if (!item) throw this.notFound('Request');
        await this.ensureWaiting(manager, item);
        if (item.version !== expectedVersion) {
          throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before saving.');
        }

        const previousConditions = item.requestedConditions;
        const nextConditions = await this.mergeAndValidateConditions(manager, item, changes);
        const updated = await manager.query(
          `WITH changed AS (
             UPDATE resource_requests
             SET requested_conditions = $1::jsonb, version = version + 1
             WHERE id = $2 AND removed_at IS NULL
             RETURNING version
           )
           SELECT version FROM changed`,
          [JSON.stringify(nextConditions), item.id],
        ) as Array<{ version: number }>;
        if (updated.length === 0) throw this.notFound('Request');
        const version = Number(updated[0].version);
        const actorSnapshot = this.actorSnapshot(actor);
        await manager.getRepository(ResourceRequestHistory).insert({
          requestId: item.id,
          actorSnapshot,
          action: 'EDITED',
          afterSnapshot: {
            requestId: item.id,
            previousConditions,
            requestedConditions: nextConditions,
            receivedAt: item.receivedAt.toISOString(),
            expirationDueAt: item.expirationDueAt.toISOString(),
            version,
          },
          correlationId: correlation,
        });
        item.requestedConditions = nextConditions;
        item.version = version;
        return item;
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async withdraw(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    reason: string,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correlation = this.requireCorrelationId(correlationId);
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0 || normalizedReason.length > 2000) {
      throw this.validationError('reason must contain between 1 and 2,000 characters.');
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const operation = await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.withdraw',
          key: idempotencyKey,
          payload: { requestId: id, ifMatch: expectedVersion, reason: normalizedReason },
        }, async () => {
          const item = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
            .setLock('pessimistic_write')
            .where('request.id = :id AND request.requester_id = :requesterId AND request.removed_at IS NULL', { id, requesterId: actor.id })
            .getOne();
          if (!item) throw this.notFound('Request');
          await this.ensureWaiting(manager, item);
          if (item.version !== expectedVersion) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before withdrawing.');
          }
          const audit = await removeResourceRequest(manager, {
            request: item,
            action: 'WITHDRAWN',
            actorSnapshot: this.actorSnapshot(actor),
            reason: normalizedReason,
            correlationId: correlation,
          });
          return this.toAuditEventResponse(audit);
        });
        return operation;
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async getAudit(localUserId: string | undefined, requestId: string) {
    const person = await this.requireActivePersonOutsideTransaction(localUserId);
    const events = await this.authorizedAuditEvents(person, requestId);
    return {
      requestId,
      events: events.slice(0, defaultPageSize).map((event) => this.toAuditEventResponse(event)),
    };
  }

  async listAuditEvents(localUserId: string | undefined, requestId: string, query: PageQuery) {
    const person = await this.requireActivePersonOutsideTransaction(localUserId);
    await this.authorizedAuditEvents(person, requestId);
    const page = this.parseAuditPage(query, requestId);
    const repository = this.dataSource.getRepository(ResourceRequestAudit);
    const builder = repository.createQueryBuilder('audit').where('audit.request_id = :requestId', { requestId });
    if (page.after) {
      builder.andWhere('(audit.occurred_at, audit.id) > (:occurredAt, :id)', {
        occurredAt: page.after.occurredAt,
        id: page.after.id,
      });
    }
    const found = await builder.orderBy('audit.occurred_at', 'ASC').addOrderBy('audit.id', 'ASC').take(page.limit + 1).getMany();
    const hasNext = found.length > page.limit;
    const items = found.slice(0, page.limit);
    const lastItem = items[items.length - 1];
    return {
      items: items.map((event) => this.toAuditEventResponse(event)),
      page: {
        nextCursor: hasNext && lastItem
          ? this.encodeCursor({
            version: cursorVersion,
            occurredAt: lastItem.occurredAt.toISOString(),
            id: lastItem.id,
            requestId,
          })
          : null,
        limit: page.limit,
      },
    };
  }

  private async mergeAndValidateConditions(
    manager: EntityManager,
    request: ResourceRequest,
    patch: UpdateRequestedConditionsDto,
  ): Promise<Record<string, unknown>> {
    const current = request.requestedConditions as Record<string, unknown>;
    const next = { ...current, ...patch };
    const referencesChanged = patch.initiativeId !== undefined || patch.groupId !== undefined || patch.resourceProfileId !== undefined;
    if (referencesChanged) {
      const initiative = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
        .setLock('pessimistic_write')
        .where('initiative.id = :id AND initiative.active = TRUE', { id: next.initiativeId })
        .getOne();
      const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
        .setLock('pessimistic_write')
        .where('group.id = :id AND group.active = TRUE', { id: next.groupId })
        .getOne();
      const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
        .setLock('pessimistic_write')
        .where('profile.id = :id AND profile.active = TRUE', { id: next.resourceProfileId })
        .getOne();
      if (!initiative || !group || !profile || profile.groupId !== group.id) {
        throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active ITDM, group, and resource profile that belongs to that group.');
      }
      Object.assign(next, {
        initiativeId: initiative.id,
        initiativeCode: initiative.code,
        initiativeName: initiative.name,
        groupId: group.id,
        groupName: group.name,
        resourceProfileId: profile.id,
        resourceProfileName: profile.name,
      });
      if (patch.initiativeId !== undefined) await markInitiativeUsedForRequest(manager, initiative.id);
    }

    if (patch.category !== undefined && !Object.values(ResourceRequestCategory).includes(patch.category)) {
      throw this.validationError('category is invalid.');
    }
    if (patch.weeklyHours !== undefined) next.weeklyHours = normalizeRequestedWeeklyHours(patch.weeklyHours);
    if (patch.startDate !== undefined || patch.endDate !== undefined) {
      const today = await this.localToday(manager);
      const startDate = String(next.startDate);
      const endDate = String(next.endDate);
      if (!this.isValidDate(startDate) || !this.isValidDate(endDate) || startDate < today || endDate < startDate) {
        throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The request dates must be valid, start today or later, and end on or after the start date.');
      }
    }
    return next;
  }

  private async localToday(manager: EntityManager): Promise<string> {
    const rows = await manager.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    return rows[0].today;
  }

  private isValidDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  }

  private async authorizedAuditEvents(person: ResourcePerson, requestId: string): Promise<ResourceRequestAudit[]> {
    const events = await this.dataSource.getRepository(ResourceRequestAudit).find({
      where: { requestId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });
    if (events.length === 0) throw this.notFound('Request audit');
    const requesterId = events[0].requestSnapshot.requesterId;
    if (person.role !== ResourceAllocationRole.Admin && requesterId !== person.id) throw this.notFound('Request audit');
    return events;
  }

  private parsePage(query: RequestCollectionQueryDto, filters: RequestCursor['filters']) {
    const limit = query.limit === undefined ? defaultPageSize : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) throw this.validationError('limit must be an integer between 1 and 100.');
    return { limit, after: query.cursor ? this.decodeRequestCursor(query.cursor, filters) : undefined };
  }

  private parseAuditPage(query: PageQuery, requestId: string) {
    const limit = query.limit === undefined ? defaultPageSize : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) throw this.validationError('limit must be an integer between 1 and 100.');
    return { limit, after: query.cursor ? this.decodeAuditCursor(query.cursor, requestId) : undefined };
  }

  private decodeRequestCursor(value: string, filters: RequestCursor['filters']): RequestCursor {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as RequestCursor;
      if (decoded.version !== cursorVersion || !this.isUuid(decoded.id) || !this.isValidInstant(decoded.receivedAt) ||
        JSON.stringify(decoded.filters) !== JSON.stringify(filters)) throw new Error('Invalid request cursor.');
      return decoded;
    } catch {
      throw this.validationError('cursor is invalid for this request collection.');
    }
  }

  private decodeAuditCursor(value: string, requestId: string): AuditCursor {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as AuditCursor;
      if (decoded.version !== cursorVersion || decoded.requestId !== requestId || !this.isUuid(decoded.id) || !this.isValidInstant(decoded.occurredAt)) {
        throw new Error('Invalid audit cursor.');
      }
      return decoded;
    } catch {
      throw this.validationError('cursor is invalid for this request audit.');
    }
  }

  private encodeCursor(value: RequestCursor | AuditCursor): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private isUuid(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  }

  private isValidInstant(value: unknown): value is string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }

  private async requireActivePersonOutsideTransaction(localUserId: string | undefined): Promise<ResourcePerson> {
    this.ensureDatabaseAvailable();
    try {
      return await this.requireActivePerson(this.dataSource.manager, localUserId);
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const localAuthEnabled = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'false' &&
      !(process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true');
    if (!localAuthEnabled) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before using Tech Resource Allocation.');
    }
    const repository = manager.getRepository(ResourcePerson);
    const person = manager.queryRunner?.isTransactionActive
      ? await repository.createQueryBuilder('person').setLock('pessimistic_write')
        .where('person.localUserId = :localUserId AND person.active = TRUE', { localUserId }).getOne()
      : await repository.findOne({ where: { localUserId, active: true } });
    if (!person) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return person;
  }

  private async ensureWaiting(manager: EntityManager, request: ResourceRequest): Promise<void> {
    if (request.decisionState !== ResourceRequestDecisionState.WaitingForPresentation) {
      throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Invalid request transition', 422, 'Only a request waiting for presentation can be edited or withdrawn.');
    }
    const rows = await manager.query('SELECT $1::timestamptz < clock_timestamp() AS expired', [request.expirationDueAt]) as Array<{ expired: boolean }>;
    if (rows[0].expired) {
      throw new ResourceAllocationException('REQUEST_EXPIRED', 'Request expired', 422, 'This request is past its waiting deadline and can no longer be edited or withdrawn.');
    }
  }

  private parseIfMatch(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match) throw this.validationError('A single strong If-Match version is required.');
    return Number(match[1]);
  }

  private requireCorrelationId(value: string | undefined): string {
    if (!value || !this.isUuid(value)) throw this.validationError('A valid X-Correlation-ID is required.');
    return value.toLowerCase();
  }

  private actorSnapshot(person: ResourcePerson) {
    return { personId: person.id, displayName: person.displayName, role: person.role };
  }

  private toRequestResponse(request: ResourceRequest, now: Date) {
    return {
      id: request.id,
      requesterSnapshot: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      decisionState: request.decisionState,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      expirationDueAt: request.expirationDueAt.toISOString(),
      dueAt: this.actionableDeadline(request)?.toISOString() ?? null,
      availableActions: this.availableActions(request, now),
      version: request.version,
    };
  }

  private actionableDeadline(request: ResourceRequest): Date | null {
    if (request.decisionState === ResourceRequestDecisionState.ApprovedWithChanges) return request.decisionResponseDueAt;
    if (request.decisionState === ResourceRequestDecisionState.WaitingForPresentation || request.decisionState === ResourceRequestDecisionState.Denied) return request.expirationDueAt;
    return null;
  }

  private availableActions(request: ResourceRequest, now: Date): string[] {
    if (request.decisionState === ResourceRequestDecisionState.RequiresRevalidation) return ['CANCEL'];
    if (request.decisionState === ResourceRequestDecisionState.ApprovedWithChanges &&
      request.decisionResponseDueAt && now < request.decisionResponseDueAt) {
      return ['ACCEPT', 'CONTEST'];
    }
    return [];
  }

  private async databaseNow(): Promise<Date> {
    const rows = await this.dataSource.query('SELECT clock_timestamp() AS now') as Array<{ now: Date }>;
    return new Date(rows[0].now);
  }

  private toAuditEventResponse(event: ResourceRequestAudit) {
    return {
      id: event.id,
      requestId: event.requestId,
      action: event.action,
      requesterSnapshot: event.requesterSnapshot,
      actorSnapshot: event.actorSnapshot,
      requestSnapshot: event.requestSnapshot,
      reason: event.reason,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
    };
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is unavailable or not prepared.', undefined, error);
    }
    throw new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}
