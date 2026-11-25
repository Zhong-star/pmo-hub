import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/opaque-cursor';
import {
  addDays,
  compareWeeks,
  isMonday,
  mondayOf,
  type ComparisonAllocation,
  type ComparisonCapacity,
  type ComparisonFigures,
  type WeekComparison,
} from './capacity-comparison';
import {
  CapacityClassification,
  CapacityCollectionQueryDto,
  CapacityComparisonQueryDto,
  CreateCapacityRequestDto,
  RemoveCapacityRequestDto,
  UpdateCapacityRequestDto,
} from './capacity.dto';

interface CapacityRow {
  id: string;
  group_id: string;
  group_name: string;
  resource_profile_id: string;
  resource_profile_name: string;
  resource_profile_active: boolean;
  classification: CapacityClassification;
  effective_date: string;
  fte: string;
  deleted_at: Date | null;
  version: number;
  effective_until?: string | null;
}

interface CapacityActor extends ResourcePerson {
  coveredGroupIds: string[];
}

interface CapacityCursor {
  version: 1;
  collection: 'capacities' | 'capacity-history';
  filtersHash?: string;
  lastId: string;
  occurredAt?: string;
  groupId?: string;
  resourceProfileId?: string;
  classification?: string;
  effectiveDate?: string;
}

const maximumComparisonWeeks = 26;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class ResourceCapacityService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async list(localUserId: string | undefined, query: CapacityCollectionQueryDto) {
    const actor = await this.requireLeader(localUserId);
    const filters = {
      ...(query.groupId ? { groupId: query.groupId.toLowerCase() } : {}),
      ...(query.resourceProfileId ? { resourceProfileId: query.resourceProfileId.toLowerCase() } : {}),
      ...(query.classification ? { classification: query.classification } : {}),
    };
    const filterHash = createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 24);
    const cursor = query.cursor ? this.decodeCursor(query.cursor, 'capacities', filterHash) : undefined;
    const limit = query.limit ?? 50;
    const groupIds = await this.authorizedGroupIds(this.dataSource.manager, actor);
    if (filters.groupId && groupIds && !groupIds.includes(filters.groupId)) throw this.accessDenied();
    if (groupIds && groupIds.length === 0) return { items: [], page: { nextCursor: null, limit } };

    const clauses = ['capacity.deleted_at IS NULL'];
    const parameters: unknown[] = [];
    const addParameter = (value: unknown): string => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    if (filters.groupId) clauses.push(`capacity.group_id = ${addParameter(filters.groupId)}::uuid`);
    else if (groupIds) clauses.push(`capacity.group_id = ANY(${addParameter(groupIds)}::uuid[])`);
    if (filters.resourceProfileId) clauses.push(`capacity.resource_profile_id = ${addParameter(filters.resourceProfileId)}::uuid`);
    if (filters.classification) clauses.push(`capacity.classification = ${addParameter(filters.classification)}::varchar`);
    if (cursor) {
      clauses.push(`(capacity.group_id, capacity.resource_profile_id, capacity.classification, capacity.effective_date, capacity.id) > (${addParameter(cursor.groupId)}::uuid, ${addParameter(cursor.resourceProfileId)}::uuid, ${addParameter(cursor.classification)}::varchar, ${addParameter(cursor.effectiveDate)}::date, ${addParameter(cursor.lastId)}::uuid)`);
    }
    const limitParameter = addParameter(limit + 1);

    try {
      const found = await this.dataSource.query(`
        SELECT capacity.id, capacity.group_id, team.name AS group_name,
          capacity.resource_profile_id, profile.name AS resource_profile_name,
          profile.active AS resource_profile_active, capacity.classification,
          capacity.effective_date::text AS effective_date, capacity.fte::text AS fte,
          capacity.deleted_at, capacity.version,
          (
            SELECT (MIN(later.effective_date) - 1)::text
            FROM resource_capacities AS later
            WHERE later.deleted_at IS NULL
              AND later.group_id = capacity.group_id
              AND later.resource_profile_id = capacity.resource_profile_id
              AND later.classification = capacity.classification
              AND later.effective_date > capacity.effective_date
          ) AS effective_until
        FROM resource_capacities AS capacity
        INNER JOIN resource_groups AS team ON team.id = capacity.group_id
        INNER JOIN resource_profiles AS profile ON profile.id = capacity.resource_profile_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY capacity.group_id ASC, capacity.resource_profile_id ASC, capacity.classification ASC, capacity.effective_date ASC, capacity.id ASC
        LIMIT ${limitParameter}::integer
      `, parameters) as CapacityRow[];
      const hasNext = found.length > limit;
      const rows = found.slice(0, limit);
      return {
        items: rows.map((row) => ({ ...this.toCapacity(row), effectiveUntil: row.effective_until ?? null })),
        page: {
          nextCursor: hasNext && rows.length > 0
            ? this.encodeCursor({
              version: 1,
              collection: 'capacities',
              filtersHash: filterHash,
              lastId: rows[rows.length - 1].id,
              groupId: rows[rows.length - 1].group_id,
              resourceProfileId: rows[rows.length - 1].resource_profile_id,
              classification: rows[rows.length - 1].classification,
              effectiveDate: rows[rows.length - 1].effective_date,
            })
            : null,
          limit,
        },
      };
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async compare(localUserId: string | undefined, query: CapacityComparisonQueryDto) {
    const actor = await this.requireLeader(localUserId);
    try {
      const clock = await this.dataSource.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date",
      ) as Array<{ business_date: string }>;
      const businessDate = clock[0].business_date;
      const firstWeek = query.weekStart ?? mondayOf(businessDate);
      const lastWeek = query.weekEnd ?? firstWeek;
      for (const [name, value] of [['weekStart', firstWeek], ['weekEnd', lastWeek]] as const) {
        this.requireValidDate(value);
        if (!isMonday(value)) throw this.validationError(`${name} must be a Monday.`);
      }
      if (lastWeek < firstWeek) throw this.validationError('weekEnd must be on or after weekStart.');
      const weekStarts: string[] = [];
      for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) weekStarts.push(week);
      if (weekStarts.length > maximumComparisonWeeks) throw this.validationError(`Choose at most ${maximumComparisonWeeks} weeks.`);
      const rangeEnd = addDays(lastWeek, 6);

      const scope = await this.authorizedGroupIds(this.dataSource.manager, actor);
      const groupId = query.groupId?.toLowerCase();
      if (groupId && scope && !scope.includes(groupId)) throw this.accessDenied();
      const groupIds = groupId ? [groupId] : scope;
      if (groupIds && groupIds.length === 0) return { businessDate, weeks: compareWeeks(weekStarts, [], [], []).map((week) => this.toComparisonWeek(week, new Map(), new Map())) };

      const profileId = query.resourceProfileId?.toLowerCase();
      const classification = query.classification;
      const parameters: unknown[] = [firstWeek, rangeEnd];
      const clauses = ["allocation.state <> 'CANCELED'", 'allocation.effective_start_date <= $2::date', 'allocation.effective_end_date >= $1::date'];
      if (groupIds) {
        parameters.push(groupIds);
        clauses.push(`allocation.group_id = ANY($${parameters.length}::uuid[])`);
      }
      if (profileId) {
        parameters.push(profileId);
        clauses.push(`allocation.resource_profile_id = $${parameters.length}::uuid`);
      }
      if (classification) {
        parameters.push(classification);
        clauses.push(`allocation.classification = $${parameters.length}::varchar`);
      }
      const allocationRows = await this.dataSource.query(`
        SELECT allocation.group_id, allocation.resource_profile_id, allocation.classification, allocation.category,
          allocation.effective_start_date::text AS start_date, allocation.effective_end_date::text AS end_date,
          allocation.weekly_hours::text AS weekly_hours, allocation.state
        FROM resource_allocations AS allocation
        WHERE ${clauses.join(' AND ')}
      `, parameters) as Array<{
        group_id: string; resource_profile_id: string | null; classification: CapacityClassification | null; category: string | null;
        start_date: string; end_date: string; weekly_hours: string; state: string;
      }>;

      const capacityParameters: unknown[] = [rangeEnd];
      const capacityClauses = ['capacity.deleted_at IS NULL', 'capacity.effective_date <= $1::date'];
      if (groupIds) {
        capacityParameters.push(groupIds);
        capacityClauses.push(`capacity.group_id = ANY($${capacityParameters.length}::uuid[])`);
      }
      if (profileId) {
        capacityParameters.push(profileId);
        capacityClauses.push(`capacity.resource_profile_id = $${capacityParameters.length}::uuid`);
      }
      if (classification) {
        capacityParameters.push(classification);
        capacityClauses.push(`capacity.classification = $${capacityParameters.length}::varchar`);
      }
      const capacityRows = await this.dataSource.query(`
        SELECT capacity.group_id, capacity.resource_profile_id, capacity.classification,
          capacity.effective_date::text AS effective_date, capacity.fte::text AS fte
        FROM resource_capacities AS capacity
        WHERE ${capacityClauses.join(' AND ')}
      `, capacityParameters) as Array<{ group_id: string; resource_profile_id: string; classification: CapacityClassification; effective_date: string; fte: string }>;

      const allocations: ComparisonAllocation[] = allocationRows.map((row) => {
        const suspended = row.state === 'SUSPENDED' && row.end_date >= businessDate;
        return {
          groupId: row.group_id,
          resourceProfileId: row.resource_profile_id,
          classification: row.classification,
          startDate: row.start_date,
          endDate: row.end_date,
          weeklyHours: Number(row.weekly_hours),
          kind: row.category === 'VACATION' ? 'VACATION' : suspended ? 'SUSPENDED' : 'PLANNED',
        };
      });
      const capacities: ComparisonCapacity[] = capacityRows.map((row) => ({
        groupId: row.group_id,
        resourceProfileId: row.resource_profile_id,
        classification: row.classification,
        effectiveDate: row.effective_date,
        fte: Number(row.fte),
      }));
      const involvedGroups = [...new Set([...allocations.map((item) => item.groupId), ...capacities.map((item) => item.groupId)])];
      const involvedProfiles = [...new Set([...allocations.map((item) => item.resourceProfileId), ...capacities.map((item) => item.resourceProfileId)]
        .filter((id): id is string => id !== null))];
      const groups = involvedGroups.length === 0 ? [] : await this.dataSource.query(
        'SELECT id, name FROM resource_groups WHERE id = ANY($1::uuid[])', [involvedGroups],
      ) as Array<{ id: string; name: string }>;
      const profiles = involvedProfiles.length === 0 ? [] : await this.dataSource.query(
        'SELECT id, name, active FROM resource_profiles WHERE id = ANY($1::uuid[])', [involvedProfiles],
      ) as Array<{ id: string; name: string; active: boolean }>;
      const groupNames = new Map(groups.map((group) => [group.id, group.name]));
      const profileInfo = new Map(profiles.map((profile) => [profile.id, { name: profile.name, active: profile.active }]));
      const orderedGroups = [...involvedGroups].sort((left, right) => (groupNames.get(left) ?? '').localeCompare(groupNames.get(right) ?? '') || left.localeCompare(right));
      return {
        businessDate,
        weeks: compareWeeks(weekStarts, allocations, capacities, orderedGroups).map((week) => this.toComparisonWeek(week, groupNames, profileInfo)),
      };
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private toComparisonWeek(
    week: WeekComparison,
    groupNames: Map<string, string>,
    profileInfo: Map<string, { name: string; active: boolean }>,
  ) {
    const withFte = (value: ComparisonFigures) => ({ ...value, capacityFte: value.capacityHours === null ? null : value.capacityHours / 40 });
    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      total: withFte(week.total),
      groups: week.groups.map((group) => ({
        group: { id: group.groupId, name: groupNames.get(group.groupId) ?? 'Unknown group' },
        unclassifiedHours: group.unclassifiedHours,
        vacationHours: group.vacationHours,
        total: withFte(group.total),
        profiles: [...group.profiles]
          .sort((left, right) => (profileInfo.get(left.resourceProfileId)?.name ?? '').localeCompare(profileInfo.get(right.resourceProfileId)?.name ?? ''))
          .map((profile) => ({
            resourceProfile: {
              id: profile.resourceProfileId,
              name: profileInfo.get(profile.resourceProfileId)?.name ?? 'Unknown profile',
              active: profileInfo.get(profile.resourceProfileId)?.active ?? false,
            },
            classifications: profile.classifications.map(withFte),
            total: withFte(profile.total),
          })),
      })),
    };
  }

  async getOptions(localUserId: string | undefined) {
    const actor = await this.requireLeader(localUserId);
    const groupIds = await this.authorizedGroupIds(this.dataSource.manager, actor);
    const parameters: unknown[] = [];
    const scoped = groupIds === null ? '' : (groupIds.length === 0
      ? 'AND FALSE'
      : `AND team.id = ANY($1::uuid[])`);
    if (groupIds !== null && groupIds.length > 0) parameters.push(groupIds);
    try {
      const rows = await this.dataSource.query(`
        SELECT team.id AS group_id, team.name AS group_name,
          profile.id AS resource_profile_id, profile.name AS resource_profile_name,
          profile.active AS resource_profile_active
        FROM resource_groups AS team
        LEFT JOIN resource_profiles AS profile ON profile.group_id = team.id AND profile.active = TRUE
        WHERE team.active = TRUE ${scoped}
        ORDER BY team.name ASC, team.id ASC, profile.name ASC, profile.id ASC
      `, parameters) as Array<{
        group_id: string;
        group_name: string;
        resource_profile_id: string | null;
        resource_profile_name: string | null;
        resource_profile_active: boolean | null;
      }>;
      const groups = new Map<string, { id: string; name: string; resourceProfiles: Array<{ id: string; name: string; active: boolean }> }>();
      for (const row of rows) {
        let group = groups.get(row.group_id);
        if (!group) {
          group = { id: row.group_id, name: row.group_name, resourceProfiles: [] };
          groups.set(row.group_id, group);
        }
        if (row.resource_profile_id && row.resource_profile_name !== null) {
          group.resourceProfiles.push({ id: row.resource_profile_id, name: row.resource_profile_name, active: row.resource_profile_active === true });
        }
      }
      return { groups: [...groups.values()] };
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async get(localUserId: string | undefined, id: string) {
    const actor = await this.requireLeader(localUserId);
    const row = await this.findCapacity(this.dataSource.manager, id);
    await this.assertGroupScope(this.dataSource.manager, actor, row.group_id, false);
    return this.toCapacity(row);
  }

  async listHistory(localUserId: string | undefined, id: string, query: { limit?: number; cursor?: string }) {
    const actor = await this.requireLeader(localUserId);
    const capacity = await this.findCapacity(this.dataSource.manager, id, true);
    await this.assertGroupScope(this.dataSource.manager, actor, capacity.group_id, false);
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? this.decodeCursor(query.cursor, 'capacity-history') : undefined;
    const parameters: unknown[] = [id];
    const after = cursor
      ? `AND (history.occurred_at, history.id) > ($2::timestamptz, $3::uuid)`
      : '';
    if (cursor) parameters.push(cursor.occurredAt, cursor.lastId);
    parameters.push(limit + 1);
    const limitParameter = `$${parameters.length}`;
    try {
      const found = await this.dataSource.query(`
        SELECT history.id, history.action, history.actor_snapshot, history.reason,
          history.before_snapshot, history.after_snapshot, history.occurred_at::text AS occurred_at
        FROM resource_capacity_history AS history
        WHERE history.capacity_id = $1::uuid ${after}
        ORDER BY history.occurred_at ASC, history.id ASC
        LIMIT ${limitParameter}::integer
      `, parameters) as Array<{
        id: string;
        action: string;
        actor_snapshot: { id: string; displayName: string };
        reason: string;
        before_snapshot: Record<string, unknown> | null;
        after_snapshot: Record<string, unknown> | null;
        occurred_at: string;
      }>;
      const hasNext = found.length > limit;
      const rows = found.slice(0, limit);
      return {
        items: rows.map((row) => ({
          id: row.id,
          action: row.action,
          actor: row.actor_snapshot,
          reason: row.reason,
          before: row.before_snapshot,
          after: row.after_snapshot,
          occurredAt: new Date(row.occurred_at).toISOString(),
        })),
        page: {
          nextCursor: hasNext && rows.length > 0
            ? this.encodeCursor({
              version: 1,
              collection: 'capacity-history',
              occurredAt: rows[rows.length - 1].occurred_at,
              lastId: rows[rows.length - 1].id,
            })
            : null,
          limit,
        },
      };
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async create(localUserId: string | undefined, idempotencyKey: string | undefined, input: CreateCapacityRequestDto) {
    const key = this.parseIdempotencyKey(idempotencyKey);
    const fte = this.roundFte(input.fte);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actor = await this.requireLeader(localUserId, manager, true);
        const group = await this.assertGroupScope(manager, actor, input.groupId, false, true);
        const payload = {
          groupId: group.id,
          resourceProfileId: input.resourceProfileId.toLowerCase(),
          classification: input.classification,
          effectiveDate: input.effectiveDate,
          fte,
          reason: input.reason.trim(),
        };
        return await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'capacity.create',
          key,
          payload,
        }, async () => {
          const currentGroup = await this.assertGroupScope(manager, actor, input.groupId, true, true);
          await this.assertManageDate(manager, actor, input.effectiveDate);
          await this.requireActiveProfile(manager, input.resourceProfileId, currentGroup.id);
          const inserted = await manager.query(`
            INSERT INTO resource_capacities
              (group_id, resource_profile_id, classification, effective_date, fte)
            VALUES ($1::uuid, $2::uuid, $3::varchar, $4::date, $5::numeric)
            RETURNING id
          `, [currentGroup.id, input.resourceProfileId, input.classification, input.effectiveDate, fte]) as Array<{ id: string }>;
          const row = await this.findCapacity(manager, inserted[0].id);
          const after = this.toCapacity(row);
          await this.writeHistory(manager, actor, row.id, 'CREATED', payload.reason, null, after);
          return after;
        });
      });
    } catch (error) {
      this.rethrowMutationError(error);
    }
  }

  async update(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    input: UpdateCapacityRequestDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch, 'A current strong If-Match version is required.');
    const key = this.parseIdempotencyKey(idempotencyKey);
    if (input.fte === undefined && input.effectiveDate === undefined) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'Change FTE or the effective date.');
    }
    const reason = input.reason.trim();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actor = await this.requireLeader(localUserId, manager, true);
        const scopedRow = await this.findCapacity(manager, id, true);
        await this.assertGroupScope(manager, actor, scopedRow.group_id, false, true);
        const payload = {
          id,
          expectedVersion,
          effectiveDate: input.effectiveDate ?? null,
          fte: input.fte === undefined ? null : this.roundFte(input.fte),
          reason,
        };
        return await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: `capacity.update:${id}`,
          key,
          payload,
        }, async () => {
          const beforeRow = await this.findCapacity(manager, id, false, true);
          await this.assertGroupScope(manager, actor, beforeRow.group_id, false, true);
          await this.assertManageDate(manager, actor, beforeRow.effective_date);
          const effectiveDate = input.effectiveDate ?? beforeRow.effective_date;
          this.requireValidDate(effectiveDate);
          await this.assertManageDate(manager, actor, effectiveDate);
          if (beforeRow.version !== expectedVersion) throw this.staleVersion();
          const fte = input.fte === undefined ? beforeRow.fte : this.roundFte(input.fte);
          const before = this.toCapacity(beforeRow);
          const updated = await manager.query(`
            UPDATE resource_capacities
            SET effective_date = $2::date, fte = $3::numeric, version = version + 1
            WHERE id = $1::uuid AND version = $4::integer AND deleted_at IS NULL
            RETURNING id
          `, [id, effectiveDate, fte, expectedVersion]) as Array<{ id: string }>;
          if (updated.length === 0) throw this.staleVersion();
          const afterRow = await this.findCapacity(manager, id);
          const after = this.toCapacity(afterRow);
          await this.writeHistory(manager, actor, id, 'UPDATED', reason, before, after);
          return after;
        });
      });
    } catch (error) {
      this.rethrowMutationError(error);
    }
  }

  async remove(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    input: RemoveCapacityRequestDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch, 'A current strong If-Match version is required.');
    const key = this.parseIdempotencyKey(idempotencyKey);
    const reason = input.reason.trim();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actor = await this.requireLeader(localUserId, manager, true);
        const scopedRow = await this.findCapacity(manager, id, true);
        await this.assertGroupScope(manager, actor, scopedRow.group_id, false, true);
        const payload = { id, expectedVersion, reason };
        return await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: `capacity.remove:${id}`,
          key,
          payload,
        }, async () => {
          const beforeRow = await this.findCapacity(manager, id, false, true);
          await this.assertGroupScope(manager, actor, beforeRow.group_id, false, true);
          await this.assertManageDate(manager, actor, beforeRow.effective_date);
          if (beforeRow.version !== expectedVersion) throw this.staleVersion();
          const before = this.toCapacity(beforeRow);
          const updated = await manager.query(`
            UPDATE resource_capacities
            SET deleted_at = clock_timestamp(), version = version + 1
            WHERE id = $1::uuid AND version = $2::integer AND deleted_at IS NULL
            RETURNING id
          `, [id, expectedVersion]) as Array<{ id: string }>;
          if (updated.length === 0) throw this.staleVersion();
          await this.writeHistory(manager, actor, id, 'REMOVED', reason, before, null);
          return { removed: true };
        });
      });
    } catch (error) {
      this.rethrowMutationError(error);
    }
  }

  private async requireLeader(
    localUserId: string | undefined,
    manager: EntityManager = this.dataSource.manager,
    lock = false,
  ): Promise<CapacityActor> {
    const configured = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED;
    if (configured === 'false' || (process.env.NODE_ENV === 'production' && configured !== 'true')) {
      throw new ResourceAllocationException('LOCAL_AUTH_DISABLED', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before opening capacity planning.');
    }
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
    try {
      const query = manager.getRepository(ResourcePerson).createQueryBuilder('person')
        .where('person.localUserId = :localUserId AND person.active = TRUE', { localUserId });
      if (lock) query.setLock('pessimistic_read');
      const actor = await query.getOne();
      if (!actor) throw this.accessDenied();
      if (![ResourceAllocationRole.Admin, ResourceAllocationRole.Moderator, ResourceAllocationRole.Supervisor, ResourceAllocationRole.Manager].includes(actor.role)) {
        throw this.accessDenied();
      }
      return actor;
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private async authorizedGroupIds(manager: EntityManager, actor: CapacityActor): Promise<string[] | null> {
    if (actor.role === ResourceAllocationRole.Admin) return null;
    if (actor.role === ResourceAllocationRole.Moderator) return actor.groupId ? [actor.groupId] : [];
    const roleColumn = actor.role === ResourceAllocationRole.Supervisor ? 'supervisor_id' : 'manager_id';
    if (actor.role !== ResourceAllocationRole.Supervisor && actor.role !== ResourceAllocationRole.Manager) return [];
    const groups = await manager.query(`
      SELECT id FROM resource_groups
      WHERE ${roleColumn} = $1::uuid OR id = ANY($2::uuid[])
    `, [actor.id, actor.coveredGroupIds ?? []]) as Array<{ id: string }>;
    return [...new Set(groups.map(({ id }) => id))];
  }

  private async assertGroupScope(
    manager: EntityManager,
    actor: CapacityActor,
    groupId: string,
    requireActive: boolean,
    lock = false,
  ): Promise<ResourceGroup> {
    const query = manager.getRepository(ResourceGroup).createQueryBuilder('team')
      .where('team.id = :groupId', { groupId });
    if (lock) query.setLock('pessimistic_read');
    const group = await query.getOne();
    if (!group) throw this.notEligible('The group is not available for capacity planning.');
    if (requireActive && !group.active) throw this.notEligible('Capacity can only be added to an active group.');
    if (actor.role !== ResourceAllocationRole.Admin) {
      const allowed = actor.role === ResourceAllocationRole.Moderator
        ? actor.groupId === group.id
        : (actor.role === ResourceAllocationRole.Supervisor && group.supervisorId === actor.id)
          || (actor.role === ResourceAllocationRole.Manager && group.managerId === actor.id)
          || actor.coveredGroupIds.includes(group.id);
      if (!allowed) throw this.accessDenied();
    }
    return group;
  }

  private async requireActiveProfile(manager: EntityManager, profileId: string, groupId: string): Promise<void> {
    const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
      .setLock('pessimistic_read')
      .where('profile.id = :profileId AND profile.groupId = :groupId AND profile.active = TRUE', { profileId, groupId })
      .getOne();
    if (!profile) throw this.notEligible('Select an active resource profile that belongs to the chosen group.');
  }

  private async assertManageDate(manager: EntityManager, actor: CapacityActor, date: string): Promise<void> {
    this.requireValidDate(date);
    if (actor.role === ResourceAllocationRole.Admin) return;
    const result = await manager.query(`
      SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS business_date
    `) as Array<{ business_date: string }>;
    if (date < result[0].business_date) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an Admin can change capacity for a past effective date.');
    }
  }

  private async findCapacity(manager: EntityManager, id: string, includeDeleted = false, lock = false): Promise<CapacityRow> {
    const rows = await manager.query(`
      SELECT capacity.id, capacity.group_id, team.name AS group_name,
        capacity.resource_profile_id, profile.name AS resource_profile_name,
        profile.active AS resource_profile_active, capacity.classification,
        capacity.effective_date::text AS effective_date, capacity.fte::text AS fte,
        capacity.deleted_at, capacity.version
      FROM resource_capacities AS capacity
      INNER JOIN resource_groups AS team ON team.id = capacity.group_id
      INNER JOIN resource_profiles AS profile ON profile.id = capacity.resource_profile_id
      WHERE capacity.id = $1::uuid ${includeDeleted ? '' : 'AND capacity.deleted_at IS NULL'}
      ${lock ? 'FOR UPDATE OF capacity' : ''}
    `, [id]) as CapacityRow[];
    if (!rows[0]) throw this.notFound('Capacity entry');
    return rows[0];
  }

  private async writeHistory(
    manager: EntityManager,
    actor: CapacityActor,
    capacityId: string,
    action: 'CREATED' | 'UPDATED' | 'REMOVED',
    reason: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await manager.query(`
      INSERT INTO resource_capacity_history
        (capacity_id, action, actor_id, actor_snapshot, reason, before_snapshot, after_snapshot)
      VALUES ($1::uuid, $2::varchar, $3::uuid, $4::jsonb, $5::text, $6::jsonb, $7::jsonb)
    `, [
      capacityId,
      action,
      actor.id,
      JSON.stringify({ id: actor.id, displayName: actor.displayName }),
      reason,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
    ]);
  }

  private toCapacity(row: CapacityRow) {
    return {
      id: row.id,
      group: { id: row.group_id, name: row.group_name },
      resourceProfile: { id: row.resource_profile_id, name: row.resource_profile_name, active: row.resource_profile_active },
      classification: row.classification,
      effectiveDate: row.effective_date,
      fte: Number(row.fte),
      version: Number(row.version),
    };
  }

  private roundFte(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw this.validationError('fte must be a finite non-negative number.');
    if (value >= 1e20) return value;
    return Math.round((value + Number.EPSILON) * 10) / 10;
  }

  private parseIdempotencyKey(value: string | undefined): string {
    return parseUuidHeader(value, 'Idempotency-Key', 'A UUID Idempotency-Key header is required.');
  }

  private decodeCursor(value: string, collection: CapacityCursor['collection'], filtersHash?: string): CapacityCursor {
    try {
      const cursor = decodeOpaqueCursor<Partial<CapacityCursor>>(value);
      if (cursor.version !== 1 || cursor.collection !== collection || !uuidPattern.test(String(cursor.lastId)) ||
        (collection === 'capacities' && (cursor.filtersHash !== filtersHash || !uuidPattern.test(String(cursor.groupId)) ||
          !uuidPattern.test(String(cursor.resourceProfileId)) || !['INTERNAL', 'THIRD_PARTY'].includes(String(cursor.classification)) ||
          !datePattern.test(String(cursor.effectiveDate)))) ||
        (collection === 'capacity-history' && (typeof cursor.occurredAt !== 'string' || Number.isNaN(Date.parse(cursor.occurredAt))))) {
        throw new Error('Invalid cursor.');
      }
      return cursor as CapacityCursor;
    } catch {
      throw this.validationError('The cursor is invalid for this collection or filter.');
    }
  }

  private encodeCursor(cursor: CapacityCursor): string {
    return encodeOpaqueCursor(cursor);
  }

  private requireValidDate(value: string): void {
    if (!datePattern.test(value)) throw this.validationError('effectiveDate must be a valid ISO date.');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw this.validationError('effectiveDate must be a valid ISO date.');
    }
  }

  private rethrowMutationError(error: unknown): never {
    if (this.isUniqueViolation(error)) {
      throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Capacity conflict', 409, 'A capacity entry already exists for this group, resource profile, classification, and effective date.');
    }
    throw translateResourceAllocationDatabaseError(error);
  }

  private isUniqueViolation(error: unknown): boolean {
    let cause = error;
    for (let depth = 0; depth < 5 && cause; depth += 1) {
      if (typeof cause !== 'object') return false;
      const value = cause as { code?: unknown; driverError?: unknown; cause?: unknown };
      if (value.code === '23505') return true;
      cause = value.driverError ?? value.cause;
    }
    return false;
  }

  private accessDenied(): ResourceAllocationException {
    return new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Capacity planning is only available to an active leader in scope or an Admin.');
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private notEligible(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('CAPACITY_TARGET_NOT_ELIGIBLE', 'Capacity target not eligible', 422, detail);
  }

  private staleVersion(): ResourceAllocationException {
    return new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The capacity entry changed. Reload it before saving.');
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }
}
