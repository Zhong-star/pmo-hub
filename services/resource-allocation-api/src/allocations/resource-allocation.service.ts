import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { correlationIdOrNew, parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/opaque-cursor';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../database/database.module';
import { ResourceAllocation } from './resource-allocation.entity';
import { ResourceAllocationHistory } from './resource-allocation-history.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import type { ResourcePersonClassification } from '../people/resource-person-classification';
import { ResourceAllocationAccessService } from '../access/resource-allocation-access.service';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { allocationCategoryLabel, isOperationalAllocationCategory, isVacationAllocation, vacationWeeklyHours } from './allocation-category';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import type { CreateAllocationDto, ReopenAllocationDto, UpdateAllocationDto, AllocationCollectionQueryDto, AllocationCommandDto, AllocationLoadQueryDto, allocationStates } from './allocation.dto';

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
  source_request_id: string | null;
  origin: 'REQUEST' | 'SELF' | 'DIRECT';
  category: string | null;
  classification: 'INTERNAL' | 'THIRD_PARTY' | null;
  comment: string | null;
  person_id: string;
  person_snapshot: Record<string, unknown>;
  group_id: string;
  group_snapshot: Record<string, unknown>;
  initiative_id: string | null;
  initiative_snapshot: Record<string, unknown> | null;
  resource_profile_id: string | null;
  resource_profile_snapshot: Record<string, unknown> | null;
  resource_profile_name?: string | null;
  resource_profile_active?: boolean | null;
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

  async createAllocation(
    localUserId: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CreateAllocationDto,
  ) {
    const key = parseUuidHeader(idempotencyKey, 'Idempotency-Key');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    const fields = this.parseCreationFields(input);

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const personId = fields.personId ?? actor.id;
        const origin: 'SELF' | 'DIRECT' = personId === actor.id ? 'SELF' : 'DIRECT';
        if (origin === 'SELF' && !isOperationalAllocationCategory(fields.category)) {
          throw this.accessDenied('Own allocations are limited to operational categories. Initiative work needs a request or a direct allocation by your leadership.');
        }

        if (origin === 'DIRECT' && actor.role === ResourceAllocationRole.User) {
          throw this.accessDenied('You can create direct allocations only for people in groups within your scope.');
        }
        const person = origin === 'SELF'
          ? actor
          : await manager.getRepository(ResourcePerson).findOne({ where: { id: personId } });
        if (!person) throw this.invalidReference('personId', 'Choose an active person from a group in your scope.');
        if (!person.groupId) {
          throw this.invalidReference('personId', origin === 'SELF'
            ? 'Your profile must belong to an active group to record an operational allocation.'
            : 'Choose an active person from a group in your scope.');
        }
        if (origin === 'DIRECT' && !await this.canLeadGroup(actor, person.groupId, manager)) {
          throw this.accessDenied('You can create direct allocations only for people in groups within your scope.');
        }
        if (!person.active) throw this.invalidReference('personId', 'Choose an active person from a group in your scope.');
        const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: person.groupId, active: true } });
        if (!group) {
          throw this.invalidReference('personId', origin === 'SELF'
            ? 'Your profile must belong to an active group to record an operational allocation.'
            : 'The person must belong to an active group.');
        }
        const profile = fields.resourceProfileId
          ? await manager.getRepository(ResourceProfile).findOne({ where: { id: fields.resourceProfileId, groupId: group.id, active: true } })
          : null;
        if (fields.resourceProfileId && !profile) {
          throw this.invalidReference('resourceProfileId', 'Choose an active resource profile from the person’s group.');
        }
        const initiative = fields.initiativeId
          ? await manager.getRepository(ResourceInitiative).findOne({ where: { id: fields.initiativeId, active: true } })
          : null;
        if (fields.initiativeId && !initiative) {
          throw this.invalidReference('initiativeId', 'Choose an active ITDM initiative.');
        }

        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'allocation.create',
          key,
          payload: {
            personId,
            category: fields.category,
            resourceProfileId: fields.resourceProfileId,
            initiativeId: fields.initiativeId,
            startDate: fields.startDate,
            endDate: fields.endDate,
            weeklyHours: fields.weeklyHours,
            comment: fields.comment,
          },
        }, async () => {
          const clockRows = await manager.query(`
            WITH operation_clock AS (SELECT clock_timestamp() AS now)
            SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date
            FROM operation_clock
          `) as Array<{ now: Date; business_date: string }>;
          const occurredAt = new Date(clockRows[0].now);
          const businessDate = clockRows[0].business_date;
          const state: AllocationState = fields.startDate > businessDate
            ? 'NOT_STARTED'
            : fields.endDate < businessDate ? 'DONE' : 'IN_PROGRESS';
          const repository = manager.getRepository(ResourceAllocation);
          const allocation = await repository.save(repository.create({
            sourceRequestId: null,
            origin,
            category: fields.category,
            comment: fields.comment,
            classification: person.classification ?? null,
            createdByPersonId: actor.id,
            personId: person.id,
            personSnapshot: { personId: person.id, displayName: person.displayName, role: person.role },
            groupId: group.id,
            groupSnapshot: { id: group.id, name: group.name },
            initiativeId: initiative?.id ?? null,
            initiativeSnapshot: initiative ? { id: initiative.id, code: initiative.code, name: initiative.name } : null,
            resourceProfileId: profile?.id ?? null,
            resourceProfileSnapshot: profile ? { id: profile.id, name: profile.name } : null,
            approvedStartDate: fields.startDate,
            approvedEndDate: fields.endDate,
            effectiveStartDate: fields.startDate,
            effectiveEndDate: fields.endDate,
            weeklyHours: fields.weeklyHours.toFixed(1),
            state,
            stateEnteredAt: occurredAt,
            approvedAt: occurredAt,
          }));
          const after = this.toResponse(this.rowFromEntity(allocation, state, businessDate), actor);
          await manager.getRepository(ResourceAllocationHistory).insert({
            allocationId: allocation.id,
            actorSnapshot: { personId: actor.id, displayName: actor.displayName, role: actor.role },
            action: origin === 'SELF' ? 'SELF_ALLOCATION_CREATED' : 'DIRECT_ALLOCATION_CREATED',
            reason: fields.comment,
            beforeSnapshot: {},
            afterSnapshot: after as never,
            correlationId: correlation,
            occurredAt,
          });
          await this.notifyAllocationCreated(manager, allocation, actor.id, occurredAt);
          return after;
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
    }
  }

  /** Active groups where the current person may record direct allocations. */
  async listDirectAllocationGroups(localUserId: string | undefined, query: { limit?: number; cursor?: string }) {
    const limit = this.parseLimit(query.limit);
    let afterId: string | undefined;
    if (query.cursor) {
      try {
        const cursor = decodeOpaqueCursor<{ version?: number; kind?: string; id?: string }>(query.cursor);
        if (cursor.version !== 1 || cursor.kind !== 'allocation-groups' || !uuidPattern.test(String(cursor.id))) throw new Error('Invalid cursor.');
        afterId = String(cursor.id);
      } catch {
        throw this.validationError('cursor is invalid.');
      }
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actor = await this.requireActivePerson(manager, localUserId);
        if (actor.role === ResourceAllocationRole.User) return { items: [], page: { nextCursor: null, limit } };
        const parameters: unknown[] = [];
        let scope = 'TRUE';
        if (actor.role === ResourceAllocationRole.Moderator) {
          parameters.push(actor.groupId);
          scope = 'team.id = $1::uuid';
        } else if (actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) {
          const column = actor.role === ResourceAllocationRole.Supervisor ? 'supervisor_id' : 'manager_id';
          parameters.push(actor.id, actor.coveredGroupIds ?? []);
          scope = `(team.id = ANY($2::uuid[]) OR team.${column} = $1::uuid)`;
        }
        parameters.push(afterId ?? null, limit + 1);
        const rows = await manager.query(`
          SELECT team.id::text AS id, team.name
          FROM resource_groups AS team
          WHERE team.active = TRUE AND ${scope}
            AND ($${parameters.length - 1}::uuid IS NULL OR team.id > $${parameters.length - 1}::uuid)
          ORDER BY team.id
          LIMIT $${parameters.length}::int
        `, parameters) as Array<{ id: string; name: string }>;
        const items = rows.slice(0, limit);
        const nextCursor = rows.length > limit
          ? encodeOpaqueCursor({ version: 1, kind: 'allocation-groups', id: items[items.length - 1].id })
          : null;
        return { items, page: { nextCursor, limit } };
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
    }
  }

  private parseCreationFields(input: CreateAllocationDto) {
    const errors: Array<{ path: string; code: string; message: string }> = [];
    const category = input.category;
    const vacation = category === 'VACATION';
    const operational = isOperationalAllocationCategory(category);
    const personId = input.personId == null ? undefined : this.requireUuid(input.personId, 'personId');
    const resourceProfileId = input.resourceProfileId == null ? null : this.requireUuid(input.resourceProfileId, 'resourceProfileId');
    const initiativeId = input.initiativeId == null ? null : this.requireUuid(input.initiativeId, 'initiativeId');
    const startDate = this.requireDate(input.startDate, 'startDate');
    const endDate = this.requireDate(input.endDate, 'endDate');
    const comment = typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim() : null;

    if (vacation && comment) errors.push({ path: 'comment', code: 'NOT_ALLOWED', message: 'Vacation does not use a description.' });
    if (vacation && resourceProfileId) errors.push({ path: 'resourceProfileId', code: 'NOT_ALLOWED', message: 'Vacation does not use a resource profile.' });
    if (!vacation && !resourceProfileId) errors.push({ path: 'resourceProfileId', code: 'REQUIRED', message: 'Choose an active resource profile.' });
    if (operational && initiativeId) errors.push({ path: 'initiativeId', code: 'NOT_ALLOWED', message: 'Operational categories do not use an ITDM initiative.' });
    if (!operational && !initiativeId) errors.push({ path: 'initiativeId', code: 'REQUIRED', message: 'Initiative categories require an ITDM initiative.' });
    if (operational && !vacation && !comment) errors.push({ path: 'comment', code: 'REQUIRED', message: 'Describe the operational activity.' });
    if (vacation && input.weeklyHours != null && Number(input.weeklyHours) !== vacationWeeklyHours) {
      errors.push({ path: 'weeklyHours', code: 'NOT_ALLOWED', message: 'Vacation always uses 40 weekly hours.' });
    }
    if (!vacation && input.weeklyHours == null) {
      errors.push({ path: 'weeklyHours', code: 'REQUIRED', message: 'Enter weekly hours greater than zero and no more than 40.' });
    }
    if (errors.length > 0) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'One or more fields are invalid.', undefined, undefined, errors);
    }
    if (startDate > endDate) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The allocation end date must be on or after its start date.');
    }
    const weeklyHours = vacation ? vacationWeeklyHours : normalizeRequestedWeeklyHours(Number(input.weeklyHours));
    return { personId, category, resourceProfileId, initiativeId, startDate, endDate, weeklyHours, comment };
  }

  private async canLeadGroup(actor: AllocationActor, groupId: string, manager: EntityManager): Promise<boolean> {
    if (actor.role === ResourceAllocationRole.Admin) return true;
    if (actor.role === ResourceAllocationRole.User) return false;
    return this.canReadAllocation(actor, '', groupId, manager);
  }

  private invalidReference(path: string, detail: string): ResourceAllocationException {
    return new ResourceAllocationException('INVALID_ALLOCATION_REFERENCE', 'Invalid allocation reference', 422, detail, undefined, undefined, [
      { path, code: 'INVALID_REFERENCE', message: detail },
    ]);
  }

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
          profile.name AS resource_profile_name,
          profile.active AS resource_profile_active,
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
        LEFT JOIN resource_profiles AS profile ON profile.id = allocation.resource_profile_id
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
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
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
          profile.name AS resource_profile_name,
          profile.active AS resource_profile_active,
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
        LEFT JOIN resource_profiles AS profile ON profile.id = allocation.resource_profile_id
        CROSS JOIN operation_clock
        WHERE allocation.id = $1::uuid
      `, [this.requireUuid(allocationId, 'allocationId')]) as AllocationRow[];
      const row = rows[0];
      if (!row) throw this.notFound('Allocation');
      if (!await this.canReadAllocation(actor, row.person_id, row.group_id)) throw this.accessDenied();
      return this.toResponse(row, actor);
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
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
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
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
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
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
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const id = this.requireUuid(allocationId, 'allocationId');
    const key = parseUuidHeader(idempotencyKey, 'Idempotency-Key');
    const correlation = correlationIdOrNew(correlationId);
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
          if (isVacationAllocation(allocation.category) && (command === 'suspend' || command === 'reserve')) {
            throw this.invalidTransition('Vacation cannot be suspended or reserved. Complete or cancel it instead.');
          }
          const nextState = this.nextState(command, currentState, allocation.effectiveStartDate, clock.businessDate);
          const nextEndDate = this.endedPeriod(command, allocation, clock.businessDate);
          const profileState = await this.currentResourceProfileState(manager, allocation.resourceProfileId);
          const before = this.toResponse(this.rowFromEntity(allocation, currentState, clock.businessDate, profileState), actor);
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
          const after = this.toResponse(this.rowFromEntity(allocation, nextState, clock.businessDate, profileState), actor);
          const actorSnapshot = { personId: actor.id, displayName: actor.displayName, role: actor.role };
          await manager.getRepository(ResourceAllocationHistory).insert({
            allocationId: allocation.id,
            actorSnapshot,
            action: this.historyAction(command, nextState),
            reason,
            beforeSnapshot: before as never,
            afterSnapshot: after as never,
            correlationId: correlation,
            occurredAt: clock.now,
          });
          await this.notifyAllocationChange(manager, allocation, actor.id, reason, nextState, clock.now, actor.id === allocation.personId ? 'LEADERS' : 'PERSON_AND_REQUESTER');
          return after;
        });
      });
      return operation;
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
    }
  }

  /** Structural change of an open allocation by in-scope leadership or Admin (#95). */
  async updateAllocation(
    localUserId: string | undefined,
    allocationId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: UpdateAllocationDto,
  ) {
    return this.maintainAllocation(localUserId, allocationId, ifMatch, idempotencyKey, correlationId, input, 'update');
  }

  /** Admin-only reopening of a Done or Canceled allocation with new dates (#96). */
  async reopenAllocation(
    localUserId: string | undefined,
    allocationId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: ReopenAllocationDto,
  ) {
    return this.maintainAllocation(localUserId, allocationId, ifMatch, idempotencyKey, correlationId, input as UpdateAllocationDto, 'reopen');
  }

  private async maintainAllocation(
    localUserId: string | undefined,
    allocationId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: UpdateAllocationDto,
    mode: 'update' | 'reopen',
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const id = this.requireUuid(allocationId, 'allocationId');
    const key = parseUuidHeader(idempotencyKey, 'Idempotency-Key');
    const correlation = correlationIdOrNew(correlationId);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 2000) throw this.validationError('reason must contain between 1 and 2,000 characters.');
    if (mode === 'reopen' && (!input.startDate || !input.endDate)) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'Reopening needs new start and end dates.', undefined, undefined, [
        ...(!input.startDate ? [{ path: 'startDate', code: 'REQUIRED', message: 'Enter the new start date.' }] : []),
        ...(!input.endDate ? [{ path: 'endDate', code: 'REQUIRED', message: 'Enter the new end date.' }] : []),
      ]);
    }
    const changes = {
      personId: input.personId == null ? undefined : this.requireUuid(input.personId, 'personId'),
      resourceProfileId: input.resourceProfileId === undefined ? undefined : input.resourceProfileId === null ? null : this.requireUuid(input.resourceProfileId, 'resourceProfileId'),
      category: input.category,
      startDate: input.startDate === undefined ? undefined : this.requireDate(input.startDate, 'startDate'),
      endDate: input.endDate === undefined ? undefined : this.requireDate(input.endDate, 'endDate'),
      weeklyHours: input.weeklyHours,
      comment: input.comment === undefined ? undefined : (typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim() : null),
      classification: input.classification,
      confirmDerivedState: input.confirmDerivedState === true,
    };
    if (mode === 'reopen' && (changes.category !== undefined || changes.weeklyHours !== undefined || changes.comment !== undefined || changes.classification !== undefined)) {
      throw this.validationError('Reopening accepts only reason, dates, person, and resource profile.');
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const allocation = await manager.getRepository(ResourceAllocation).createQueryBuilder('allocation')
          .setLock('pessimistic_write')
          .where('allocation.id = :id', { id })
          .getOne();
        if (!allocation) throw this.notFound('Allocation');
        if (!await this.canReadAllocation(actor, allocation.personId, allocation.groupId, manager)) throw this.accessDenied();
        if (mode === 'reopen' && actor.role !== ResourceAllocationRole.Admin) {
          throw this.accessDenied('Only an Admin can reopen a done or canceled allocation.');
        }
        if (mode === 'update' && !await this.canLeadGroup(actor, allocation.groupId, manager)) {
          throw this.accessDenied('Only leadership in scope or an Admin can change an allocation. You can still change its state.');
        }
        if (changes.classification !== undefined && actor.role !== ResourceAllocationRole.Admin) {
          throw this.accessDenied('Only an Admin can correct the classification recorded on an allocation.');
        }

        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: mode === 'reopen' ? 'allocation.reopen' : 'allocation.update',
          key,
          payload: { allocationId: id, ifMatch: expectedVersion, reason, ...changes },
        }, async () => {
          if (allocation.version !== expectedVersion) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The allocation changed. Reload and review it before saving your change.');
          }
          const clocks = await manager.query(`
            WITH operation_clock AS (SELECT clock_timestamp() AS now)
            SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date
            FROM operation_clock
          `) as Array<OperationClock & { business_date: string }>;
          const clock = { now: new Date(clocks[0].now), businessDate: clocks[0].business_date };
          const currentState = this.currentState(allocation, clock.businessDate);
          const terminal = currentState === 'DONE' || currentState === 'CANCELED';
          if (mode === 'update' && terminal) {
            throw this.invalidTransition('Done or canceled allocations cannot be changed. An Admin can reopen them.');
          }
          if (mode === 'reopen' && !terminal) {
            throw this.invalidTransition('Only a done or canceled allocation can be reopened.');
          }

          const fieldErrors: Array<{ path: string; code: string; message: string }> = [];
          const currentCategory = allocation.category;
          const nextCategory = changes.category ?? currentCategory;
          if (changes.category !== undefined && changes.category !== currentCategory) {
            if (!isOperationalAllocationCategory(currentCategory) || !isOperationalAllocationCategory(changes.category)) {
              throw this.invalidTransition('Only operational categories can be switched among themselves. Cancel the allocation and record a new one to move between initiative and operational work.');
            }
          }
          const vacation = isVacationAllocation(nextCategory);
          const leavingVacation = isVacationAllocation(currentCategory) && !vacation;
          const enteringVacation = !isVacationAllocation(currentCategory) && vacation;

          const startDate = changes.startDate ?? allocation.effectiveStartDate;
          const endDate = changes.endDate ?? allocation.effectiveEndDate;
          if (startDate > endDate) {
            throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The allocation end date must be on or after its start date.');
          }

          const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: allocation.groupId } });
          if (mode === 'reopen') {
            if (!group?.active) throw this.invalidTransition('Reactivate the allocation group before reopening it.');
            if (allocation.initiativeId) {
              const initiative = await manager.getRepository(ResourceInitiative).findOne({ where: { id: allocation.initiativeId } });
              if (!initiative?.active) throw this.invalidTransition('Reactivate the ITDM initiative before reopening this allocation.');
            }
          }

          let person: ResourcePerson | null = null;
          const personChanged = changes.personId !== undefined && changes.personId !== allocation.personId;
          if (personChanged || mode === 'reopen') {
            person = await manager.getRepository(ResourcePerson).findOne({ where: { id: changes.personId ?? allocation.personId } });
            if (!person || !person.active || person.groupId !== allocation.groupId) {
              fieldErrors.push({ path: 'personId', code: 'INVALID_REFERENCE', message: 'Choose an active person from the allocation group.' });
            }
          }

          let profile: ResourceProfile | null | undefined;
          if (vacation) {
            if (changes.resourceProfileId) fieldErrors.push({ path: 'resourceProfileId', code: 'NOT_ALLOWED', message: 'Vacation does not use a resource profile.' });
            profile = null;
          } else {
            const nextProfileId = changes.resourceProfileId === undefined ? allocation.resourceProfileId : changes.resourceProfileId;
            const profileChanged = nextProfileId !== allocation.resourceProfileId;
            if (!nextProfileId) {
              fieldErrors.push({ path: 'resourceProfileId', code: 'REQUIRED', message: 'Choose an active resource profile.' });
            } else if (profileChanged || mode === 'reopen') {
              profile = await manager.getRepository(ResourceProfile).findOne({ where: { id: nextProfileId, groupId: allocation.groupId, active: true } });
              if (!profile) fieldErrors.push({ path: 'resourceProfileId', code: 'INVALID_REFERENCE', message: 'Choose an active resource profile from the allocation group.' });
            }
          }

          let weeklyHours = Number(allocation.weeklyHours);
          if (vacation) {
            if (changes.weeklyHours != null && Number(changes.weeklyHours) !== vacationWeeklyHours) {
              fieldErrors.push({ path: 'weeklyHours', code: 'NOT_ALLOWED', message: 'Vacation always uses 40 weekly hours.' });
            }
            weeklyHours = vacationWeeklyHours;
          } else if (changes.weeklyHours != null) {
            weeklyHours = normalizeRequestedWeeklyHours(Number(changes.weeklyHours));
          } else if (leavingVacation) {
            fieldErrors.push({ path: 'weeklyHours', code: 'REQUIRED', message: 'Enter weekly hours for the new category.' });
          }

          let comment = allocation.comment;
          if (vacation) {
            if (changes.comment) fieldErrors.push({ path: 'comment', code: 'NOT_ALLOWED', message: 'Vacation does not use a description.' });
            comment = null;
          } else if (changes.comment !== undefined) {
            comment = changes.comment;
          }
          if (!vacation && isOperationalAllocationCategory(nextCategory) && !comment) {
            fieldErrors.push({ path: 'comment', code: 'REQUIRED', message: 'Describe the operational activity.' });
          }
          if (fieldErrors.length > 0) {
            throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'One or more fields are invalid.', undefined, undefined, fieldErrors);
          }

          const keepsHeldState = !vacation && mode === 'update' && (allocation.state === 'SUSPENDED' || allocation.state === 'ALLOCATED_WITHOUT_ACTION');
          const nextState: AllocationState = endDate < clock.businessDate
            ? 'DONE'
            : keepsHeldState
              ? allocation.state as AllocationState
              : startDate > clock.businessDate ? 'NOT_STARTED' : 'IN_PROGRESS';
          if (enteringVacation && (allocation.state === 'SUSPENDED' || allocation.state === 'ALLOCATED_WITHOUT_ACTION') && !changes.confirmDerivedState) {
            throw new ResourceAllocationException(
              'DERIVED_STATE_CONFIRMATION_REQUIRED', 'Confirmation required', 422,
              `Vacation cannot stay ${this.stateLabel(allocation.state as AllocationState).toLowerCase()}. Confirm that it becomes ${this.stateLabel(nextState).toLowerCase()} from its dates.`,
            );
          }

          const fingerprint = (value: Record<string, unknown>) => JSON.stringify(value);
          const unchanged = mode === 'update' && fingerprint({
            personId: allocation.personId, profileId: allocation.resourceProfileId, category: allocation.category, comment: allocation.comment,
            startDate: allocation.effectiveStartDate, endDate: allocation.effectiveEndDate, hours: Number(allocation.weeklyHours),
            classification: allocation.classification, state: allocation.state,
          }) === fingerprint({
            personId: person && personChanged ? person.id : allocation.personId,
            profileId: profile === undefined ? allocation.resourceProfileId : profile?.id ?? null,
            category: nextCategory, comment, startDate, endDate, hours: weeklyHours,
            classification: changes.classification !== undefined ? changes.classification : person && personChanged ? person.classification ?? null : allocation.classification,
            state: nextState,
          });
          if (unchanged) throw this.validationError('Change at least one field before saving.');

          const profileState = await this.currentResourceProfileState(manager, allocation.resourceProfileId);
          const before = this.toResponse(this.rowFromEntity(allocation, currentState, clock.businessDate, profileState), actor);
          const previousPersonId = allocation.personId;
          if (person && personChanged) {
            allocation.personId = person.id;
            allocation.personSnapshot = { personId: person.id, displayName: person.displayName, role: person.role };
            allocation.classification = person.classification ?? null;
          }
          if (changes.classification !== undefined) allocation.classification = changes.classification as ResourcePersonClassification | null;
          if (profile !== undefined) {
            allocation.resourceProfileId = profile?.id ?? null;
            allocation.resourceProfileSnapshot = profile ? { id: profile.id, name: profile.name } : null;
          }
          allocation.category = nextCategory;
          allocation.comment = comment;
          allocation.effectiveStartDate = startDate;
          allocation.effectiveEndDate = endDate;
          allocation.weeklyHours = weeklyHours.toFixed(1);
          if (nextState !== allocation.state) {
            allocation.state = nextState;
            allocation.stateEnteredAt = clock.now;
          }
          const saved = await manager.getRepository(ResourceAllocation).save(allocation);
          const savedProfileState = await this.currentResourceProfileState(manager, saved.resourceProfileId);
          const after = this.toResponse(this.rowFromEntity(saved, nextState, clock.businessDate, savedProfileState), actor);
          await manager.getRepository(ResourceAllocationHistory).insert({
            allocationId: saved.id,
            actorSnapshot: { personId: actor.id, displayName: actor.displayName, role: actor.role },
            action: mode === 'reopen' ? 'ALLOCATION_REOPENED' : 'ALLOCATION_UPDATED',
            reason,
            beforeSnapshot: before as never,
            afterSnapshot: after as never,
            correlationId: correlation,
            occurredAt: clock.now,
          });
          await this.notifyAllocationMaintained(manager, saved, previousPersonId, actor.id, reason, mode, clock.now);
          return after;
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
    }
  }

  private async notifyAllocationMaintained(
    manager: EntityManager,
    allocation: ResourceAllocation,
    previousPersonId: string,
    actorId: string,
    reason: string,
    mode: 'update' | 'reopen',
    occurredAt: Date,
  ): Promise<void> {
    const requests = allocation.sourceRequestId
      ? await manager.query('SELECT requester_id FROM resource_requests WHERE id = $1::uuid', [allocation.sourceRequestId]) as Array<{ requester_id: string }>
      : [];
    const requesterId = requests[0]?.requester_id ?? null;
    const recipients = await manager.query(`
      SELECT DISTINCT person.id::text AS id
      FROM resource_people AS person
      WHERE person.active = TRUE AND person.id <> $1::uuid
        AND (person.id = $2::uuid OR person.id = $3::uuid OR ($4::uuid IS NOT NULL AND person.id = $4::uuid))
      ORDER BY id
    `, [actorId, allocation.personId, previousPersonId, requesterId]) as Array<{ id: string }>;
    if (recipients.length === 0) return;
    const subject = String(allocation.initiativeSnapshot?.code ?? allocationCategoryLabel(allocation.category) ?? 'the allocation');
    await manager.getRepository(ResourceAllocationNotification).createQueryBuilder()
      .insert()
      .into(ResourceAllocationNotification)
      .values(recipients.map(({ id }) => ({
        recipientId: id,
        sourceRequestId: allocation.sourceRequestId,
        sourceAllocationId: allocation.sourceRequestId ? null : allocation.id,
        eventCode: `ALLOCATION_${mode === 'reopen' ? 'REOPENED' : 'UPDATED'}_${allocation.version}`,
        title: mode === 'reopen' ? 'Allocation reopened' : 'Allocation changed',
        message: id === previousPersonId && previousPersonId !== allocation.personId
          ? `The allocation for ${subject} was reassigned to someone else. Reason: ${reason}`
          : `The allocation for ${subject} now runs ${allocation.effectiveStartDate} to ${allocation.effectiveEndDate} at ${Number(allocation.weeklyHours).toFixed(1)} weekly hours. Reason: ${reason}`,
        createdAt: occurredAt,
      })))
      .orIgnore()
      .execute();
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
      throw translateResourceAllocationDatabaseError(error, 'The Resource Allocation database is unavailable.');
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
      const profileState = await this.currentResourceProfileState(manager, allocation.resourceProfileId);
      const before = this.toResponse(this.rowFromEntity(allocation, allocation.state as AllocationState, clock.businessDate, profileState));
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
      const after = this.toResponse(this.rowFromEntity(allocation, nextState, clock.businessDate, profileState));
      const action = nextState === 'IN_PROGRESS' ? 'ALLOCATION_STARTED' : 'ALLOCATION_ENDED';
      const reason = nextState === 'IN_PROGRESS'
        ? 'Automatically started on its São Paulo start date.'
        : 'Automatically completed after its inclusive end date.';
      await manager.getRepository(ResourceAllocationHistory).insert({
        allocationId: allocation.id,
        actorSnapshot: { displayName: 'Resource Allocation lifecycle worker', role: 'SYSTEM' },
        action,
        reason,
        beforeSnapshot: before as never,
        afterSnapshot: after as never,
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
    audience: 'LEADERS' | 'PERSON_AND_REQUESTER' | 'ALL' = 'ALL',
  ): Promise<void> {
    const requests = allocation.sourceRequestId
      ? await manager.query('SELECT requester_id FROM resource_requests WHERE id = $1::uuid', [allocation.sourceRequestId]) as Array<{ requester_id: string }>
      : [];
    if (allocation.sourceRequestId && !requests[0]) throw new Error('The allocation source request is missing.');
    const requesterId = requests[0]?.requester_id ?? null;
    const recipients = await manager.query(`
      SELECT DISTINCT person.id::text AS id
      FROM resource_people AS person
      LEFT JOIN resource_groups AS team ON team.id = $1::uuid
      WHERE person.active = TRUE AND person.id <> $2::uuid AND (
        ($5::boolean AND (person.id = $3::uuid OR ($4::uuid IS NOT NULL AND person.id = $4::uuid)))
        OR ($6::boolean AND (
          (person.role = 'ALLOCATION_MODERATOR' AND person.group_id = team.id)
          OR (person.role = 'ALLOCATION_SUPERVISOR' AND (
            person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.supervisor_id = person.id
          ))
          OR (person.role = 'ALLOCATION_MANAGER' AND (
            person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.manager_id = person.id
          ))
        ))
      )
      ORDER BY id
    `, [allocation.groupId, actorId, allocation.personId, requesterId, audience !== 'LEADERS', audience !== 'PERSON_AND_REQUESTER']) as Array<{ id: string }>;
    const titleState = this.stateLabel(nextState);
    const code = `ALLOCATION_${nextState}_${allocation.version}`;
    const sourceName = String(allocation.initiativeSnapshot?.code ?? allocationCategoryLabel(allocation.category) ?? 'the initiative');
    const repository = manager.getRepository(ResourceAllocationNotification);
    await repository.createQueryBuilder()
      .insert()
      .into(ResourceAllocationNotification)
      .values(recipients.map(({ id }) => ({
        recipientId: id,
        sourceRequestId: allocation.sourceRequestId,
        sourceAllocationId: allocation.sourceRequestId ? null : allocation.id,
        eventCode: code,
        title: `Allocation ${titleState.toLowerCase()}`,
        message: `The allocation for ${sourceName} changed to ${titleState}. Reason: ${reason}`,
        createdAt: occurredAt,
      })))
      .orIgnore()
      .execute();
  }

  private async notifyAllocationCreated(
    manager: EntityManager,
    allocation: ResourceAllocation,
    actorId: string,
    occurredAt: Date,
  ): Promise<void> {
    const self = allocation.origin === 'SELF';
    const recipients = self
      ? await manager.query(`
        SELECT DISTINCT person.id::text AS id
        FROM resource_people AS person
        LEFT JOIN resource_groups AS team ON team.id = $1::uuid
        WHERE person.active = TRUE AND person.id <> $2::uuid AND (
          (person.role = 'ALLOCATION_MODERATOR' AND person.group_id = team.id)
          OR (person.role = 'ALLOCATION_SUPERVISOR' AND (
            person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.supervisor_id = person.id
          ))
          OR (person.role = 'ALLOCATION_MANAGER' AND (
            person.covered_group_ids @> ARRAY[team.id]::uuid[] OR team.manager_id = person.id
          ))
        )
        ORDER BY id
      `, [allocation.groupId, actorId]) as Array<{ id: string }>
      : await manager.query(`
        SELECT person.id::text AS id
        FROM resource_people AS person
        WHERE person.active = TRUE AND person.id = $1::uuid AND person.id <> $2::uuid
      `, [allocation.personId, actorId]) as Array<{ id: string }>;
    if (recipients.length === 0) return;
    const category = allocationCategoryLabel(allocation.category) ?? 'Allocation';
    const subject = allocation.initiativeSnapshot ? `${category} for ${String(allocation.initiativeSnapshot.code)}` : category;
    const period = `from ${allocation.effectiveStartDate} to ${allocation.effectiveEndDate} at ${Number(allocation.weeklyHours).toFixed(1)} weekly hours`;
    await manager.getRepository(ResourceAllocationNotification).createQueryBuilder()
      .insert()
      .into(ResourceAllocationNotification)
      .values(recipients.map(({ id }) => ({
        recipientId: id,
        sourceRequestId: null,
        sourceAllocationId: allocation.id,
        eventCode: 'ALLOCATION_CREATED',
        title: self ? 'New self allocation' : 'New direct allocation',
        message: self
          ? `${subject} was self-allocated by ${String(allocation.personSnapshot.displayName)} ${period}.`
          : `${subject} was allocated to you ${period}.`,
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
        $3::uuid = ANY($2::uuid[]) OR EXISTS (
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
      source: row.origin,
      category: row.category,
      classification: row.classification,
      comment: row.comment,
      person: { personId: row.person_id, displayName: row.person_snapshot.displayName },
      group: { id: row.group_id, name: row.group_snapshot.name },
      initiative: row.initiative_snapshot
        ? { id: row.initiative_id, code: row.initiative_snapshot.code, name: row.initiative_snapshot.name }
        : null,
      resourceProfile: row.resource_profile_id && row.resource_profile_snapshot
        ? {
          id: row.resource_profile_id,
          name: row.resource_profile_name ?? row.resource_profile_snapshot.name,
          active: row.resource_profile_active ?? true,
        }
        : null,
      startDate: row.effective_start_date,
      endDate: row.effective_end_date,
      approvedPeriod: { startDate: row.approved_start_date, endDate: row.approved_end_date },
      weeklyHours: Number(row.weekly_hours),
      state,
      approvedAt: new Date(row.approved_at).toISOString(),
      version: Number(row.version),
      availableActions: actor ? this.availableActions(state, started, isVacationAllocation(row.category)) : [],
    };
  }

  private rowFromEntity(
    allocation: ResourceAllocation,
    state: AllocationState,
    businessDate: string,
    profileState?: { name: string; active: boolean },
  ): AllocationRow {
    return {
      id: allocation.id,
      source_request_id: allocation.sourceRequestId,
      origin: allocation.origin,
      category: allocation.category,
      classification: allocation.classification,
      comment: allocation.comment,
      person_id: allocation.personId,
      person_snapshot: allocation.personSnapshot,
      group_id: allocation.groupId,
      group_snapshot: allocation.groupSnapshot,
      initiative_id: allocation.initiativeId,
      initiative_snapshot: allocation.initiativeSnapshot,
      resource_profile_id: allocation.resourceProfileId,
      resource_profile_snapshot: allocation.resourceProfileSnapshot,
      resource_profile_name: profileState?.name,
      resource_profile_active: profileState?.active,
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

  private async currentResourceProfileState(manager: EntityManager, profileId: string | null): Promise<{ name: string; active: boolean } | undefined> {
    if (!profileId) return undefined;
    const profile = await manager.getRepository(ResourceProfile).findOne({
      where: { id: profileId },
      select: { id: true, name: true, active: true },
    });
    return profile ? { name: profile.name, active: profile.active } : undefined;
  }

  private availableActions(state: AllocationState, started: boolean, vacation = false): string[] {
    if (vacation) {
      if (state === 'NOT_STARTED') return ['CANCEL'];
      if (state === 'IN_PROGRESS') return ['COMPLETE', 'CANCEL'];
      return [];
    }
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
      const cursor = decodeOpaqueCursor<Partial<AllocationCursor>>(value);
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
      const cursor = decodeOpaqueCursor<Partial<LoadCursor>>(value);
      if (cursor.version !== 1 || cursor.kind !== 'allocation-load' || typeof cursor.filtersHash !== 'string' ||
        typeof cursor.displayName !== 'string' || !uuidPattern.test(String(cursor.personId))) throw new Error('Invalid cursor.');
      return cursor as LoadCursor;
    } catch {
      throw this.validationError('cursor is invalid.');
    }
  }

  private decodeHistoryCursor(value: string): { allocationId: string; occurredAt: string; id: string } {
    try {
      const cursor = decodeOpaqueCursor<Record<string, unknown>>(value);
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
    return encodeOpaqueCursor(value);
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

  private accessDenied(detail = 'The active profile is not authorized to access this allocation.'): ResourceAllocationException {
    return new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, detail);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

}
