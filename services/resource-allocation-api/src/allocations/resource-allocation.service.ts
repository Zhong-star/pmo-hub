import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../database/database.module';
import { ResourceAllocation } from './resource-allocation.entity';
import { ResourceAllocationHistory } from './resource-allocation-history.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceAllocationAccessService } from '../access/resource-allocation-access.service';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import type { AllocationCollectionQueryDto, AllocationCommandDto, AllocationLoadQueryDto, allocationStates } from './allocation.dto';

const defaultPageSize = 50;
const maximumPageSize = 100;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const systemActorId = '00000000-0000-4000-8000-000000000000';

type AllocationState = typeof allocationStates[number];
type AllocationCommand = 'suspend' | 'reserve' | 'resume' | 'activate' | 'complete' | 'cancel';

interface AllocationActor {
  id: string;
  role: ResourceAllocationRole;
  groupId: string | null;
  coveredGroupIds: string[];
}

interface AllocationCursor {
  version: 1;
  kind: 'allocations';
  filtersHash: string;
  effectiveStartDate: string;
  id: string;
}

interface LoadCursor {
  version: 1;
  kind: 'allocation-load';
  filtersHash: string;
  displayName: string;
  personId: string;
}

interface AllocationRow {
  id: string;
  source_request_id: string;
  person_id: string;
  person_snapshot: Record<string, unknown>;
  group_id: string;
  group_snapshot: Record<string, unknown>;
  initiative_id: string;
  initiative_snapshot: Record<string, unknown>;
  resource_profile_id: string;
  resource_profile_snapshot: Record<string, unknown>;
  approved_start_date: string;
  approved_end_date: string;
  effective_start_date: string;
  effective_end_date: string;
  weekly_hours: string;
  state: AllocationState;
  response_state: AllocationState;
  business_date: string;
  state_entered_at: Date;
  approved_at: Date;
  version: number;
}

interface OperationClock {
  now: Date;
  businessDate: string;
}

@Injectable()
export class ResourceAllocationService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(ResourceAllocationAccessService)
    private readonly accessService: ResourceAllocationAccessService,
  ) {}

  async list(localUserId: string | undefined, query: AllocationCollectionQueryDto) {
    const { actor, filters, limit, after } = await this.prepareList(localUserId, query);
    try {
      const parameters: unknown[] = [];
      const clauses = this.scopeClauses(actor, 'allocation', parameters);
      this.addAllocationFilters(filters, clauses, parameters);
      const filtersHash = this.hashFilters(filters);
      if (after) {
        if (after.filtersHash !== filtersHash) throw this.validationError('The allocation cursor is invalid for the current filters.');
        parameters.push(after.effectiveStartDate, after.id);
        clauses.push(`(allocation.effective_start_date, allocation.id) > ($${parameters.length - 1}::date, $${parameters.length}::uuid)`);
      }
      parameters.push(limit + 1);
      const rows = await this.dataSource.query(`
        WITH operation_clock AS MATERIALIZED (
          SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS business_date
        )
        SELECT allocation.*,
          allocation.approved_start_date::text AS approved_start_date,
          allocation.approved_end_date::text AS approved_end_date,
          allocation.effective_start_date::text AS effective_start_date,
          allocation.effective_end_date::text AS effective_end_date,
          CASE
            WHEN allocation.state = 'CANCELED' THEN 'CANCELED'
            WHEN operation_clock.business_date > allocation.effective_end_date THEN 'DONE'
            WHEN allocation.state = 'DONE' THEN 'DONE'
            WHEN allocation.state IN ('SUSPENDED', 'ALLOCATED_WITHOUT_ACTION') THEN allocation.state
            WHEN operation_clock.business_date < allocation.effective_start_date THEN 'NOT_STARTED'
            ELSE 'IN_PROGRESS'
          END AS response_state,
          operation_clock.business_date::text AS business_date
        FROM resource_allocations AS allocation
        CROSS JOIN operation_clock
        WHERE ${clauses.join(' AND ')}
        ORDER BY allocation.effective_start_date ASC, allocation.id ASC
        LIMIT $${parameters.length}::int
      `, parameters) as AllocationRow[];
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => this.toResponse(row, actor));
      const last = rows[limit - 1];
      return {
        items,
        page: {
          nextCursor: hasNext && last ? this.encodeCursor({
            version: 1,
            kind: 'allocations',
            filtersHash,
            effectiveStartDate: last.effective_start_date,
            id: last.id,
          }) : null,
          limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async get(localUserId: string | undefined, allocationId: string) {
    const { person: actor } = await this.accessService.getAccess(localUserId);
    try {
      const rows = await this.dataSource.query(`
        WITH operation_clock AS MATERIALIZED (
          SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS business_date
        )
        SELECT allocation.*,
          allocation.approved_start_date::text AS approved_start_date,
          allocation.approved_end_date::text AS approved_end_date,
          allocation.effective_start_date::text AS effective_start_date,
          allocation.effective_end_date::text AS effective_end_date,
          CASE
            WHEN allocation.state = 'CANCELED' THEN 'CANCELED'
            WHEN operation_clock.business_date > allocation.effective_end_date THEN 'DONE'
            WHEN allocation.state = 'DONE' THEN 'DONE'
            WHEN allocation.state IN ('SUSPENDED', 'ALLOCATED_WITHOUT_ACTION') THEN allocation.state
            WHEN operation_clock.business_date < allocation.effective_start_date THEN 'NOT_STARTED'
            ELSE 'IN_PROGRESS'
          END AS response_state,
          operation_clock.business_date::text AS business_date
        FROM resource_allocations AS allocation
        CROSS JOIN operation_clock
        WHERE allocation.id = $1::uuid
      `, [this.requireUuid(allocationId, 'allocationId')]) as AllocationRow[];
      const row = rows[0];
      if (!row) throw this.notFound('Allocation');
      if (!await this.canReadAllocation(actor, row.person_id, row.group_id)) throw this.accessDenied();
      return this.toResponse(row, actor);
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async load(localUserId: string | undefined, query: AllocationLoadQueryDto) {
    const { person: actor } = await this.accessService.getAccess(localUserId);
    const limit = this.parseLimit(query.limit);
    const date = this.requireDate(query.date, 'date');
    const filters = {
      date,
      personId: this.optionalUuid(query.personId, 'personId'),
      groupId: this.optionalUuid(query.groupId, 'groupId'),
      resourceProfileId: this.optionalUuid(query.resourceProfileId, 'resourceProfileId'),
      initiativeId: this.optionalUuid(query.initiativeId, 'initiativeId'),
    };
    const filtersHash = this.hashFilters(filters);
    const after = query.cursor ? this.decodeLoadCursor(query.cursor) : undefined;
    if (after && after.filtersHash !== filtersHash) throw this.validationError('The allocation load cursor is invalid for the current filters.');

    try {
      const parameters: unknown[] = [];
      const clauses = this.scopeClauses(actor, 'allocation', parameters);
      parameters.push(date);
      clauses.push(`allocation.effective_start_date <= $${parameters.length}::date`);
      clauses.push(`allocation.effective_end_date >= $${parameters.length}::date`);
      clauses.push("allocation.response_state NOT IN ('DONE', 'CANCELED')");
      this.addAllocationFilters(filters, clauses, parameters, ['date']);
      if (after) {
        parameters.push(after.displayName, after.personId);
        clauses.push(`(person.display_name, person.id) > ($${parameters.length - 1}::text, $${parameters.length}::uuid)`);
      }
      parameters.push(limit + 1);
      const rows = await this.dataSource.query(`
        WITH operation_clock AS MATERIALIZED (
          SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS business_date
        ), eligible_allocations AS (
          SELECT allocation.*,
            CASE
              WHEN allocation.state = 'CANCELED' THEN 'CANCELED'
              WHEN operation_clock.business_date > allocation.effective_end_date THEN 'DONE'
              WHEN allocation.state = 'DONE' THEN 'DONE'
              WHEN allocation.state IN ('SUSPENDED', 'ALLOCATED_WITHOUT_ACTION') THEN allocation.state
              WHEN operation_clock.business_date < allocation.effective_start_date THEN 'NOT_STARTED'
              ELSE 'IN_PROGRESS'
            END AS response_state
          FROM resource_allocations AS allocation
          CROSS JOIN operation_clock
        )
        SELECT person.id::text AS person_id, person.display_name,
          COALESCE(SUM(allocation.weekly_hours) FILTER (WHERE allocation.response_state = 'NOT_STARTED'), 0)::numeric(8,1)::text AS not_started,
          COALESCE(SUM(allocation.weekly_hours) FILTER (WHERE allocation.response_state = 'IN_PROGRESS'), 0)::numeric(8,1)::text AS in_progress,
          COALESCE(SUM(allocation.weekly_hours) FILTER (WHERE allocation.response_state = 'SUSPENDED'), 0)::numeric(8,1)::text AS suspended,
          COALESCE(SUM(allocation.weekly_hours) FILTER (WHERE allocation.response_state = 'ALLOCATED_WITHOUT_ACTION'), 0)::numeric(8,1)::text AS allocated_without_action
        FROM eligible_allocations AS allocation
        INNER JOIN resource_people AS person ON person.id = allocation.person_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY person.id, person.display_name
        ORDER BY person.display_name ASC, person.id ASC
        LIMIT $${parameters.length}::int
      `, parameters) as Array<{
        person_id: string;
        display_name: string;
        not_started: string;
        in_progress: string;
        suspended: string;
        allocated_without_action: string;
      }>;
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => {
        const weeklyHoursByState = {
          NOT_STARTED: Number(row.not_started),
          IN_PROGRESS: Number(row.in_progress),
          SUSPENDED: Number(row.suspended),
          ALLOCATED_WITHOUT_ACTION: Number(row.allocated_without_action),
          DONE: 0,
          CANCELED: 0,
        };
        return {
          person: { personId: row.person_id, displayName: row.display_name },
          weeklyHoursByState,
          totalWeeklyHours: Object.values(weeklyHoursByState).reduce((total, weeklyHours) => total + weeklyHours, 0),
        };
      });
      const last = rows[limit - 1];
      return {
        date,
        items,
        page: {
          nextCursor: hasNext && last ? this.encodeCursor({
            version: 1,
            kind: 'allocation-load',
            filtersHash,
            displayName: last.display_name,
            personId: last.person_id,
          }) : null,
          limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async listHistory(localUserId: string | undefined, allocationId: string, query: { limit?: string; cursor?: string }) {
    const allocation = await this.get(localUserId, allocationId);
    const limit = this.parseLimit(query.limit === undefined ? undefined : Number(query.limit));
    const after = query.cursor ? this.decodeHistoryCursor(query.cursor) : undefined;
    try {
      if (after && after.allocationId !== allocation.id) throw this.validationError('The history cursor is invalid for this allocation.');
      const parameters: unknown[] = [allocation.id];
      let afterClause = '';
      if (after) {
        parameters.push(after.occurredAt, after.id);
        afterClause = `AND (occurred_at, id) > ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`;
      }
      parameters.push(limit + 1);
      const rows = await this.dataSource.query(`
        SELECT id, actor_snapshot, action, reason, before_snapshot, after_snapshot,
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
          correlation_id
        FROM resource_allocation_history
        WHERE allocation_id = $1::uuid ${afterClause}
        ORDER BY occurred_at ASC, id ASC
        LIMIT $${parameters.length}::int
      `, parameters) as Array<Record<string, unknown> & { id: string; occurred_at: string }>;
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        id: row.id,
        actor: row.actor_snapshot,
        action: row.action,
        reason: row.reason,
        before: row.before_snapshot,
        after: row.after_snapshot,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
      }));
      const last = rows[limit - 1];
      return {
        items,
        page: {
          nextCursor: hasNext && last ? this.encodeCursor({
            version: 1,
            kind: 'allocation-history',
            allocationId: allocation.id,
            occurredAt: last.occurred_at,
            id: last.id,
          }) : null,
          limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async changeState(
    localUserId: string | undefined,
    allocationId: string,
    command: AllocationCommand,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: AllocationCommandDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const id = this.requireUuid(allocationId, 'allocationId');
    const key = this.requireUuid(idempotencyKey, 'Idempotency-Key');
    const correlation = this.requireUuid(correlationId, 'X-Correlation-ID');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 2000) throw this.validationError('reason must contain between 1 and 2,000 characters.');

    try {
      const operation = await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const allocation = await manager.getRepository(ResourceAllocation).createQueryBuilder('allocation')
          .setLock('pessimistic_write')
          .where('allocation.id = :id', { id })
          .getOne();
        if (!allocation) throw this.notFound('Allocation');
        if (!await this.canReadAllocation(actor, allocation.personId, allocation.groupId, manager)) throw this.accessDenied();

        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: `allocation.${command}`,
          key,
          payload: { allocationId: id, ifMatch: expectedVersion, reason },
        }, async () => {
          if (allocation.version !== expectedVersion) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The allocation changed. Reload and review it before changing its state.');
          }
          const clocks = await manager.query(`
            WITH operation_clock AS (SELECT clock_timestamp() AS now)
            SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date
            FROM operation_clock
          `) as Array<OperationClock & { business_date: string }>;
          const clock = { now: new Date(clocks[0].now), businessDate: clocks[0].business_date };
          const currentState = this.currentState(allocation, clock.businessDate);
          const nextState = this.nextState(command, currentState, allocation.effectiveStartDate, clock.businessDate);
          const nextEndDate = this.endedPeriod(command, allocation, clock.businessDate);
          const before = this.toResponse(this.rowFromEntity(allocation, currentState, clock.businessDate), actor);
          const updatedRows = await manager.query(`
            WITH changed AS (
              UPDATE resource_allocations
              SET state = $2, state_entered_at = $3::timestamptz,
                  effective_end_date = $4::date, version = version + 1
              WHERE id = $1::uuid AND version = $5::int
              RETURNING version
            )
            SELECT version FROM changed
          `, [id, nextState, clock.now, nextEndDate, expectedVersion]) as Array<{ version: number }>;
          if (updatedRows.length === 0) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The allocation changed. Reload and review it before changing its state.');
          }
          allocation.state = nextState;
          allocation.stateEnteredAt = clock.now;
          allocation.effectiveEndDate = nextEndDate;
          allocation.version = Number(updatedRows[0].version);
          const after = this.toResponse(this.rowFromEntity(allocation, nextState, clock.businessDate), actor);
          const actorSnapshot = { personId: actor.id, displayName: actor.displayName, role: actor.role };
          await manager.getRepository(ResourceAllocationHistory).insert({
            allocationId: allocation.id,
            actorSnapshot,
            action: this.historyAction(command, nextState),
            reason,
            beforeSnapshot: before,
            afterSnapshot: after,
            correlationId: correlation,
            occurredAt: clock.now,
          });
          await this.notifyAllocationChange(manager, allocation, actor.id, reason, nextState, clock.now);
          return after;
        });
      });
      return operation;
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  /** Applies date-driven allocation states once per due allocation, using the database's São Paulo date. */
  async processScheduledBatch(limit = maximumPageSize): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) {
      throw new RangeError(`The allocation lifecycle batch limit must be between 1 and ${maximumPageSize}.`);
    }
    try {
      const candidates = await this.dataSource.query(`
        WITH operation_clock AS MATERIALIZED (
          SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS business_date
        )
        SELECT allocation.id::text AS id
        FROM resource_allocations AS allocation
        CROSS JOIN operation_clock
        WHERE allocation.state NOT IN ('DONE', 'CANCELED')
          AND (
            (allocation.state = 'NOT_STARTED' AND allocation.effective_start_date <= operation_clock.business_date)
            OR allocation.effective_end_date < operation_clock.business_date
          )
        ORDER BY allocation.effective_end_date ASC, allocation.id ASC
        LIMIT $1::int
      `, [limit]) as Array<{ id: string }>;
      let processed = 0;
      for (const { id } of candidates) {
        if (await this.processScheduledAllocation(id)) processed += 1;
      }
      return processed;
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async processScheduledAllocation(allocationId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const allocation = await manager.getRepository(ResourceAllocation).createQueryBuilder('allocation')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('allocation.id = :id AND allocation.state NOT IN (:...terminal)', {
          id: allocationId,
          terminal: ['DONE', 'CANCELED'],
        })
        .getOne();
      if (!allocation) return false;
      const clocks = await manager.query(`
        WITH operation_clock AS (SELECT clock_timestamp() AS now)
        SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date
        FROM operation_clock
      `) as Array<OperationClock & { business_date: string }>;
      const clock = { now: new Date(clocks[0].now), businessDate: clocks[0].business_date };
      const nextState = this.currentState(allocation, clock.businessDate);
      if (nextState === allocation.state) return false;
      const before = this.toResponse(this.rowFromEntity(allocation, allocation.state as AllocationState, clock.businessDate));
      const updated = await manager.query(`
        WITH changed AS (
          UPDATE resource_allocations
          SET state = $2, state_entered_at = $3::timestamptz, version = version + 1
          WHERE id = $1::uuid AND version = $4::int AND state NOT IN ('DONE', 'CANCELED')
          RETURNING version
        )
        SELECT version FROM changed
      `, [allocation.id, nextState, clock.now, allocation.version]) as Array<{ version: number }>;
      if (updated.length === 0) return false;
      allocation.state = nextState;
      allocation.stateEnteredAt = clock.now;
      allocation.version = Number(updated[0].version);
      const after = this.toResponse(this.rowFromEntity(allocation, nextState, clock.businessDate));
      const action = nextState === 'IN_PROGRESS' ? 'ALLOCATION_STARTED' : 'ALLOCATION_ENDED';
      const reason = nextState === 'IN_PROGRESS'
        ? 'Automatically started on its São Paulo start date.'
        : 'Automatically completed after its inclusive end date.';
      await manager.getRepository(ResourceAllocationHistory).insert({
        allocationId: allocation.id,
        actorSnapshot: { displayName: 'Resource Allocation lifecycle worker', role: 'SYSTEM' },
        action,
        reason,
        beforeSnapshot: before,
        afterSnapshot: after,
        correlationId: randomUUID(),
        occurredAt: clock.now,
      });
      await this.notifyAllocationChange(manager, allocation, systemActorId, reason, nextState, clock.now);
      return true;
    });
  }

  private async notifyAllocationChange(
    manager: EntityManager,
    allocation: ResourceAllocation,
    actorId: string,
    reason: string,
    nextState: AllocationState,
    occurredAt: Date,
  ): Promise<void> {
    const requests = await manager.query('SELECT requester_id FROM resource_requests WHERE id = $1::uuid', [allocation.sourceRequestId]) as Array<{ requester_id: string }>;
    const requestRow = requests[0];
    if (!requestRow) throw new Error('The allocation source request is missing.');
    const recipients = await manager.query(`
      SELECT DISTINCT person.id::text AS id
      FROM resource_people AS person
      LEFT JOIN resource_groups AS team ON team.id = $1::uuid
      WHERE person.active = TRUE AND person.id <> $2::uuid AND (
        person.id = $3::uuid OR person.id = $4::uuid
        OR (person.role = 'ALLOCATION_MODERATOR' AND person.group_id = team.id)
        OR (person.role = 'ALLOCATION_SUPERVISOR' AND (
          person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.supervisor_id = person.id
        ))
        OR (person.role = 'ALLOCATION_MANAGER' AND (
          person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.manager_id = person.id
        ))
      )
      ORDER BY id
    `, [allocation.groupId, actorId, allocation.personId, requestRow.requester_id]) as Array<{ id: string }>;
    const titleState = this.stateLabel(nextState);
    const code = `ALLOCATION_${nextState}_${allocation.version}`;
    const repository = manager.getRepository(ResourceAllocationNotification);
    await repository.createQueryBuilder()
      .insert()
      .into(ResourceAllocationNotification)
      .values(recipients.map(({ id }) => ({
        recipientId: id,
        sourceRequestId: allocation.sourceRequestId,
        eventCode: code,
        title: `Allocation ${titleState.toLowerCase()}`,
        message: `The allocation for ${String(allocation.initiativeSnapshot.code ?? 'the initiative')} changed to ${titleState}. Reason: ${reason}`,
        createdAt: occurredAt,
      })))
      .orIgnore()
      .execute();
  }

  private async prepareList(localUserId: string | undefined, query: AllocationCollectionQueryDto) {
    const { person: actor } = await this.accessService.getAccess(localUserId);
    const limit = this.parseLimit(query.limit);
    const filters = {
      initiativeId: this.optionalUuid(query.initiativeId, 'initiativeId'),
      personId: this.optionalUuid(query.personId, 'personId'),
      groupId: this.optionalUuid(query.groupId, 'groupId'),
      resourceProfileId: this.optionalUuid(query.resourceProfileId, 'resourceProfileId'),
      operationalState: query.operationalState,
      periodStart: query.periodStart === undefined ? undefined : this.requireDate(query.periodStart, 'periodStart'),
      periodEnd: query.periodEnd === undefined ? undefined : this.requireDate(query.periodEnd, 'periodEnd'),
    };
    if (filters.periodStart && filters.periodEnd && filters.periodStart > filters.periodEnd) {
      throw this.validationError('periodStart must be on or before periodEnd.');
    }
    const after = query.cursor ? this.decodeAllocationCursor(query.cursor) : undefined;
    return { actor, filters, limit, after };
  }

  private addAllocationFilters(
    filters: Record<string, unknown>,
    clauses: string[],
    parameters: unknown[],
    excludedKeys: string[] = [],
  ): void {
    const conditions: Array<[string, string, string]> = [
      ['initiativeId', 'allocation.initiative_id', 'uuid'],
      ['personId', 'allocation.person_id', 'uuid'],
      ['groupId', 'allocation.group_id', 'uuid'],
      ['resourceProfileId', 'allocation.resource_profile_id', 'uuid'],
      ['operationalState', 'allocation.state', 'text'],
    ];
    for (const [key, column, type] of conditions) {
      const value = filters[key];
      if (value === undefined || excludedKeys.includes(key)) continue;
      parameters.push(value);
      clauses.push(key === 'operationalState'
        ? `(${this.stateExpression('allocation')}) = $${parameters.length}::${type}`
        : `${column} = $${parameters.length}::${type}`);
    }
    const periodStart = filters.periodStart as string | undefined;
    const periodEnd = filters.periodEnd as string | undefined;
    if (periodEnd) {
      parameters.push(periodEnd);
      clauses.push(`allocation.effective_start_date <= $${parameters.length}::date`);
    }
    if (periodStart) {
      parameters.push(periodStart);
      clauses.push(`allocation.effective_end_date >= $${parameters.length}::date`);
    }
  }

  private scopeClauses(actor: AllocationActor, alias: string, parameters: unknown[]): string[] {
    if (actor.role === ResourceAllocationRole.Admin) return ['TRUE'];
    parameters.push(actor.id);
    const owner = `${alias}.person_id = $${parameters.length}::uuid`;
    if (actor.role === ResourceAllocationRole.User) {
      return [owner];
    }
    if (actor.role === ResourceAllocationRole.Moderator) {
      if (!actor.groupId) return [owner];
      parameters.push(actor.groupId);
      return [`(${owner} OR ${alias}.group_id = $${parameters.length}::uuid)`];
    }
    if (actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) {
      parameters.push(actor.coveredGroupIds ?? []);
      const groupRoleColumn = actor.role === ResourceAllocationRole.Supervisor ? 'supervisor_id' : 'manager_id';
      return [`(${owner} OR ${alias}.group_id = ANY($${parameters.length}::uuid[]) OR EXISTS (
        SELECT 1 FROM resource_groups AS scoped_group
        WHERE scoped_group.id = ${alias}.group_id AND scoped_group.${groupRoleColumn} = $${parameters.length - 1}::uuid
      ))`];
    }
    return [owner];
  }

  private async canReadAllocation(actor: AllocationActor, personId: string, groupId: string, manager?: EntityManager): Promise<boolean> {
    if (actor.role === ResourceAllocationRole.Admin || actor.id === personId) return true;
    if (actor.role === ResourceAllocationRole.User) return false;
    if (actor.role === ResourceAllocationRole.Moderator) return actor.groupId === groupId;
    if (actor.role !== ResourceAllocationRole.Supervisor && actor.role !== ResourceAllocationRole.Manager) return false;
    const column = actor.role === ResourceAllocationRole.Supervisor ? 'supervisor_id' : 'manager_id';
    const rows = await (manager ?? this.dataSource.manager).query(`
      SELECT (
        $1::uuid = ANY($2::uuid[]) OR EXISTS (
          SELECT 1 FROM resource_groups AS team WHERE team.id = $3::uuid AND team.${column} = $1::uuid
        )
      ) AS allowed
    `, [actor.id, actor.coveredGroupIds ?? [], groupId]) as Array<{ allowed: boolean }>;
    return rows[0]?.allowed === true;
  }

  private currentState(allocation: ResourceAllocation, businessDate: string): AllocationState {
    if (allocation.state === 'CANCELED') return 'CANCELED';
    if (businessDate > allocation.effectiveEndDate || allocation.state === 'DONE') return 'DONE';
    if (allocation.state === 'SUSPENDED' || allocation.state === 'ALLOCATED_WITHOUT_ACTION') return allocation.state;
    return businessDate < allocation.effectiveStartDate ? 'NOT_STARTED' : 'IN_PROGRESS';
  }

  private nextState(command: AllocationCommand, current: AllocationState, startDate: string, businessDate: string): AllocationState {
    const transitions: Record<AllocationCommand, { from: AllocationState[]; to: AllocationState }> = {
      suspend: { from: ['NOT_STARTED', 'IN_PROGRESS', 'ALLOCATED_WITHOUT_ACTION'], to: 'SUSPENDED' },
      reserve: { from: ['NOT_STARTED', 'IN_PROGRESS', 'SUSPENDED'], to: 'ALLOCATED_WITHOUT_ACTION' },
      resume: { from: ['SUSPENDED'], to: businessDate < startDate ? 'NOT_STARTED' : 'IN_PROGRESS' },
      activate: { from: ['ALLOCATED_WITHOUT_ACTION'], to: businessDate < startDate ? 'NOT_STARTED' : 'IN_PROGRESS' },
      complete: { from: ['IN_PROGRESS', 'SUSPENDED', 'ALLOCATED_WITHOUT_ACTION'], to: 'DONE' },
      cancel: { from: ['NOT_STARTED', 'IN_PROGRESS', 'SUSPENDED', 'ALLOCATED_WITHOUT_ACTION'], to: 'CANCELED' },
    };
    const transition = transitions[command];
    if (!transition.from.includes(current)) throw this.invalidTransition();
    if (command === 'complete' && businessDate < startDate) throw this.invalidTransition('A future allocation cannot be completed. Cancel it to preserve its approved period.');
    return transition.to;
  }

  private endedPeriod(command: AllocationCommand, allocation: ResourceAllocation, businessDate: string): string {
    if (command === 'complete' || command === 'cancel') {
      if (businessDate >= allocation.effectiveStartDate && businessDate < allocation.effectiveEndDate) return businessDate;
    }
    return allocation.effectiveEndDate;
  }

  private historyAction(command: AllocationCommand, state: AllocationState): string {
    const actions: Record<AllocationCommand, string> = {
      suspend: 'SUSPENDED',
      reserve: 'RESERVED_WITHOUT_ACTION',
      resume: 'RESUMED',
      activate: 'ACTIVATED',
      complete: 'COMPLETED',
      cancel: 'CANCELED',
    };
    return `ALLOCATION_${actions[command]}_${state}`;
  }

  private toResponse(row: AllocationRow, actor?: AllocationActor) {
    const state = row.response_state ?? row.state;
    const started = row.business_date >= row.effective_start_date;
    return {
      id: row.id,
      requestId: row.source_request_id,
      person: { personId: row.person_id, displayName: row.person_snapshot.displayName },
      group: { id: row.group_id, name: row.group_snapshot.name },
      initiative: { id: row.initiative_id, code: row.initiative_snapshot.code, name: row.initiative_snapshot.name },
      resourceProfile: { id: row.resource_profile_id, name: row.resource_profile_snapshot.name },
      startDate: row.effective_start_date,
      endDate: row.effective_end_date,
      approvedPeriod: { startDate: row.approved_start_date, endDate: row.approved_end_date },
      weeklyHours: Number(row.weekly_hours),
      state,
      approvedAt: new Date(row.approved_at).toISOString(),
      version: Number(row.version),
      availableActions: actor ? this.availableActions(state, started) : [],
    };
  }

  private rowFromEntity(allocation: ResourceAllocation, state: AllocationState, businessDate: string): AllocationRow {
    return {
      id: allocation.id,
      source_request_id: allocation.sourceRequestId,
      person_id: allocation.personId,
      person_snapshot: allocation.personSnapshot,
      group_id: allocation.groupId,
      group_snapshot: allocation.groupSnapshot,
      initiative_id: allocation.initiativeId,
      initiative_snapshot: allocation.initiativeSnapshot,
      resource_profile_id: allocation.resourceProfileId,
      resource_profile_snapshot: allocation.resourceProfileSnapshot,
      approved_start_date: allocation.approvedStartDate,
      approved_end_date: allocation.approvedEndDate,
      effective_start_date: allocation.effectiveStartDate,
      effective_end_date: allocation.effectiveEndDate,
      weekly_hours: allocation.weeklyHours,
      state: allocation.state as AllocationState,
      response_state: state,
      business_date: businessDate,
      state_entered_at: allocation.stateEnteredAt,
      approved_at: allocation.approvedAt,
      version: allocation.version,
    };
  }

  private availableActions(state: AllocationState, started: boolean): string[] {
    if (state === 'NOT_STARTED') return ['SUSPEND', 'RESERVE', 'CANCEL'];
    if (state === 'IN_PROGRESS') return ['SUSPEND', 'RESERVE', 'COMPLETE', 'CANCEL'];
    if (state === 'SUSPENDED') return ['RESUME', 'RESERVE', ...(started ? ['COMPLETE'] : []), 'CANCEL'];
    if (state === 'ALLOCATED_WITHOUT_ACTION') return ['ACTIVATE', 'SUSPEND', ...(started ? ['COMPLETE'] : []), 'CANCEL'];
    return [];
  }

  private stateExpression(alias: string): string {
    return `CASE
      WHEN ${alias}.state = 'CANCELED' THEN 'CANCELED'
      WHEN operation_clock.business_date > ${alias}.effective_end_date THEN 'DONE'
      WHEN ${alias}.state = 'DONE' THEN 'DONE'
      WHEN ${alias}.state IN ('SUSPENDED', 'ALLOCATED_WITHOUT_ACTION') THEN ${alias}.state
      WHEN operation_clock.business_date < ${alias}.effective_start_date THEN 'NOT_STARTED'
      ELSE 'IN_PROGRESS'
    END`;
  }

  private async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const configured = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED;
    if (configured === 'false' || (process.env.NODE_ENV === 'production' && configured !== 'true')) {
      throw this.accessDenied();
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before changing an allocation.');
    }
    const actor = await manager.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw this.accessDenied();
    return actor;
  }

  private parseIfMatch(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw this.validationError('A single strong If-Match version is required.');
    return Number(match[1]);
  }

  private parseLimit(value: number | undefined): number {
    const limit = value ?? defaultPageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) throw this.validationError('limit must be an integer from 1 to 100.');
    return limit;
  }

  private optionalUuid(value: string | undefined, name: string): string | undefined {
    return value === undefined ? undefined : this.requireUuid(value, name);
  }

  private requireUuid(value: string | undefined, name: string): string {
    if (!value || !uuidPattern.test(value)) throw this.validationError(`${name} must be a UUID.`);
    return value.toLowerCase();
  }

  private requireDate(value: string, name: string): string {
    if (!datePattern.test(value)) throw this.validationError(`${name} must be a valid ISO date.`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw this.validationError(`${name} must be a valid ISO date.`);
    }
    return value;
  }

  private hashFilters(filters: Record<string, unknown>): string {
    const normalized = Object.fromEntries(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)));
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
  }

  private decodeAllocationCursor(value: string): AllocationCursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AllocationCursor>;
      if (cursor.version !== 1 || cursor.kind !== 'allocations' || typeof cursor.filtersHash !== 'string' ||
        typeof cursor.effectiveStartDate !== 'string' || !uuidPattern.test(String(cursor.id))) throw new Error('Invalid cursor.');
      this.requireDate(cursor.effectiveStartDate, 'cursor date');
      return cursor as AllocationCursor;
    } catch {
      throw this.validationError('cursor is invalid.');
    }
  }

  private decodeLoadCursor(value: string): LoadCursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LoadCursor>;
      if (cursor.version !== 1 || cursor.kind !== 'allocation-load' || typeof cursor.filtersHash !== 'string' ||
        typeof cursor.displayName !== 'string' || !uuidPattern.test(String(cursor.personId))) throw new Error('Invalid cursor.');
      return cursor as LoadCursor;
    } catch {
      throw this.validationError('cursor is invalid.');
    }
  }

  private decodeHistoryCursor(value: string): { allocationId: string; occurredAt: string; id: string } {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (cursor.version !== 1 || cursor.kind !== 'allocation-history' || !uuidPattern.test(String(cursor.allocationId)) ||
        !uuidPattern.test(String(cursor.id)) || typeof cursor.occurredAt !== 'string' || Number.isNaN(Date.parse(cursor.occurredAt))) {
        throw new Error('Invalid cursor.');
      }
      return cursor as { allocationId: string; occurredAt: string; id: string };
    } catch {
      throw this.validationError('history cursor is invalid.');
    }
  }

  private encodeCursor(value: AllocationCursor | LoadCursor | { version: 1; kind: 'allocation-history'; allocationId: string; occurredAt: string; id: string }): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  private stateLabel(state: AllocationState): string {
    return ({
      NOT_STARTED: 'Not Started',
      IN_PROGRESS: 'In Progress',
      SUSPENDED: 'Suspended',
      ALLOCATED_WITHOUT_ACTION: 'Allocated without action',
      DONE: 'Done',
      CANCELED: 'Canceled',
    } as const)[state];
  }

  private invalidTransition(detail = 'This allocation cannot move to the requested state. Refresh it and check its current state.'): ResourceAllocationException {
    return new ResourceAllocationException('INVALID_ALLOCATION_TRANSITION', 'Invalid allocation transition', 422, detail);
  }

  private accessDenied(): ResourceAllocationException {
    return new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The active profile is not authorized to access this allocation.');
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is unavailable.', undefined, error);
    }
    throw new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}
