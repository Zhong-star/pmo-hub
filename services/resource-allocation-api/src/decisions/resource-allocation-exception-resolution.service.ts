import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { allocationResponse } from '../allocations/allocation-response';
import { createResourceAllocationForRequest } from '../allocations/create-resource-allocation-for-request';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import { requireAdminExceptionActor } from './exception-request-authorization';
import type { CancelDeniedRequestDto } from './request-decision.dto';
import { resolutionStrategies, type RecordRequestStrategyDto, type ResolutionStrategy, type ResolveRequestExceptionDto } from './resolve-exception.dto';
import { ResourceAllocationDecisionSupport } from './resource-allocation-decision-support';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ResourceAllocationExceptionResolutionService extends ResourceAllocationDecisionSupport {
  constructor(@Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource, @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean) {
    super(dataSource, databaseConfigured);
  }

  async escalate(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CancelDeniedRequestDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const current = await this.lockRequest(manager, requestId);
        requireAdminExceptionActor(actor, current);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.exception.escalate',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, reason },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          requireAdminExceptionActor(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['PRE_N3'], 'Only a Pre N3 request may be escalated.');

          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          item.decisionState = 'ESCALATION';
          item.stageEnteredAt = occurredAt;
          const saved = await manager.getRepository(ResourceRequest).save(item);
          await this.recordHistory(manager, saved, actor, 'ESCALATED', before, this.snapshot(saved), reason, correlation, occurredAt);
          const admins = await this.activeAdminIds(manager);
          await this.notifyRecipients(manager, admins, actor.id, saved, `REQUEST_EXCEPTION_ESCALATED_${saved.version}`, 'Resource request escalated', 'A contested resource request was explicitly escalated for resolution.', occurredAt);
          return this.toResponse(saved);
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async recordStrategy(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: RecordRequestStrategyDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    const strategy = this.normalizeStrategy(input.strategy);
    const affectedIds = this.normalizeAffectedInitiativeIds(strategy, input.affectedInitiativeIds);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const current = await this.lockRequest(manager, requestId);
        requireAdminExceptionActor(actor, current);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.exception.recordStrategy',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, strategy, reason, affectedInitiativeIds: affectedIds },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          requireAdminExceptionActor(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['PRE_N3', 'ESCALATION'], 'A resolution strategy can only be recorded for Pre N3 or Escalation.');
          const affectedInitiatives = await this.lockActiveInitiatives(manager, affectedIds);
          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          await manager.query('UPDATE resource_requests SET version = version + 1 WHERE id = $1', [item.id]);
          const saved = await manager.getRepository(ResourceRequest).findOneByOrFail({ id: item.id });
          await manager.getRepository(ResourceRequestHistory).insert({
            requestId: item.id,
            actorSnapshot: this.actorSnapshot(actor),
            action: 'STRATEGY_RECORDED',
            afterSnapshot: {
              requestId: item.id,
              before,
              after: this.snapshot(saved),
              reason,
              resolutionStrategy: strategy,
              affectedInitiativeIds: affectedIds,
              affectedInitiatives,
            },
            correlationId: correlation,
            occurredAt,
          });
          await this.notifyRecipients(manager, [saved.requesterId], actor.id, saved, `REQUEST_STRATEGY_RECORDED_${saved.version}`, 'Resource request resolution strategy recorded', 'An Admin recorded a resolution strategy. The request remains in the exception queue until eligible conditions can be confirmed.', occurredAt);
          return { ...this.toResponse(saved), resolutionStrategy: strategy, affectedInitiativeIds: affectedIds, allocation: null };
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async resolveException(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: ResolveRequestExceptionDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    const strategy = this.normalizeStrategy(input.strategy);
    const affectedIds = this.normalizeAffectedInitiativeIds(strategy, input.affectedInitiativeIds);
    const personId = this.normalizeUuid(input.personId, 'personId');
    const resourceProfileId = this.normalizeUuid(input.resourceProfileId, 'resourceProfileId');
    const startDate = this.normalizeBusinessDate(input.startDate, 'startDate');
    const endDate = this.normalizeBusinessDate(input.endDate, 'endDate');
    if (endDate < startDate) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The final allocation end date must be on or after its start date.');
    }
    const weeklyHours = normalizeRequestedWeeklyHours(input.weeklyHours);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const current = await this.lockRequest(manager, requestId);
        requireAdminExceptionActor(actor, current);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.exception.resolve',
          key: idempotencyKey,
          payload: {
            requestId,
            ifMatch: expectedVersion,
            strategy,
            reason,
            affectedInitiativeIds: affectedIds,
            personId,
            resourceProfileId,
            startDate,
            endDate,
            weeklyHours,
          },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          requireAdminExceptionActor(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['PRE_N3', 'ESCALATION'], 'Only a Pre N3 or Escalation request can be resolved.');
          const requested = item.requestedConditions;
          const groupId = this.normalizeUuid(String(requested.groupId ?? ''), 'request group');
          const initiativeId = this.normalizeUuid(String(requested.initiativeId ?? ''), 'request ITDM');
          const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
            .setLock('pessimistic_write')
            .where('group.id = :id AND group.active = TRUE', { id: groupId })
            .getOne();
          const person = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
            .setLock('pessimistic_write')
            .where('person.id = :id AND person.active = TRUE AND person.group_id = :groupId', { id: personId, groupId })
            .getOne();
          const initiative = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
            .setLock('pessimistic_write')
            .where('initiative.id = :id AND initiative.active = TRUE', { id: initiativeId })
            .getOne();
          const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
            .setLock('pessimistic_write')
            .where('profile.id = :id AND profile.active = TRUE AND profile.group_id = :groupId', { id: resourceProfileId, groupId })
            .getOne();
          if (!group || !person || !initiative || !profile) {
            throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active person, group, ITDM, and profile that belong together.');
          }
          const previousProfileId = item.approvedConditions?.resourceProfileId ?? requested.resourceProfileId;
          if (previousProfileId !== profile.id) {
            const currentProfile = typeof previousProfileId === 'string' && uuidPattern.test(previousProfileId)
              ? await manager.getRepository(ResourceProfile).findOneBy({ id: previousProfileId, active: true, groupId })
              : null;
            if (!currentProfile) {
              throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Correct the inactive or mismatched profile with a reason before resolving the exception.');
            }
          }
          const previousPersonId = item.approvedConditions?.personId;
          if (typeof previousPersonId === 'string' && previousPersonId !== person.id) {
            const currentPerson = uuidPattern.test(previousPersonId)
              ? await manager.getRepository(ResourcePerson).findOneBy({ id: previousPersonId, active: true, groupId })
              : null;
            if (!currentPerson) {
              throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Correct the inactive or out-of-group proposed person with a reason before resolving the exception.');
            }
          }
          const affectedInitiatives = await this.lockActiveInitiatives(manager, affectedIds);
          const clockRows = await manager.query(`
            WITH operation_clock AS (SELECT clock_timestamp() AS now)
            SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
            FROM operation_clock
          `) as Array<{ now: Date; today: string }>;
          const occurredAt = new Date(clockRows[0].now);
          if (startDate < clockRows[0].today) {
            throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The final allocation period must start today or in the future.');
          }
          const approvedConditions = {
            personId: person.id,
            personName: person.displayName,
            resourceProfileId: profile.id,
            resourceProfileName: profile.name,
            groupId: group.id,
            groupName: group.name,
            initiativeId: initiative.id,
            initiativeCode: initiative.code,
            initiativeName: initiative.name,
            startDate,
            endDate,
            weeklyHours,
            resolutionStrategy: strategy,
            resolutionReason: reason,
            ...(affectedIds.length > 0 ? { affectedInitiativeIds: affectedIds } : {}),
          };
          const before = this.snapshot(item);
          item.approvedConditions = approvedConditions;
          item.decisionState = 'APPROVED';
          item.stageEnteredAt = occurredAt;
          item.decisionResponseDueAt = null;
          const saved = await manager.getRepository(ResourceRequest).save(item);
          const allocation = await createResourceAllocationForRequest(manager, {
            requestId: saved.id,
            category: String(saved.requestedConditions.category),
            person,
            group,
            initiative,
            profile,
            startDate,
            endDate,
            weeklyHours,
            occurredAt,
            businessDate: clockRows[0].today,
          });
          await manager.getRepository(ResourceRequestHistory).insert({
            requestId: saved.id,
            actorSnapshot: this.actorSnapshot(actor),
            action: 'EXCEPTION_RESOLVED',
            afterSnapshot: {
              requestId: saved.id,
              before,
              after: this.snapshot(saved),
              reason,
              resolutionStrategy: strategy,
              affectedInitiativeIds: affectedIds,
              affectedInitiatives,
              approvedConditions,
              allocationId: allocation.id,
            },
            correlationId: correlation,
            occurredAt,
          });
          await this.notifyRecipients(
            manager,
            [saved.requesterId, person.id],
            actor.id,
            saved,
            `REQUEST_EXCEPTION_RESOLVED_${saved.version}`,
            'Resource request resolved',
            `The request was approved through ${strategy.toLowerCase().replaceAll('_', ' ')} for ${startDate} to ${endDate} at ${weeklyHours.toFixed(1)} weekly hours.`,
            occurredAt,
          );
          return {
            ...this.toResponse(saved),
            approvedConditions,
            allocation: allocationResponse(allocation),
            resolutionStrategy: strategy,
            affectedInitiativeIds: affectedIds,
          };
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private normalizeStrategy(value: unknown): ResolutionStrategy {
    if (typeof value !== 'string' || !resolutionStrategies.includes(value as ResolutionStrategy)) {
      throw this.validationError('strategy must be OUTSOURCE, WAIT_FOR_EMB_RESOURCE, or DEPRIORITIZE_OTHER_DEMANDS.');
    }
    return value as ResolutionStrategy;
  }

  private normalizeAffectedInitiativeIds(strategy: ResolutionStrategy, values: string[] | undefined): string[] {
    const ids = (values ?? []).map((value) => this.normalizeUuid(value, 'affectedInitiativeIds'));
    if (new Set(ids).size !== ids.length) throw this.validationError('affectedInitiativeIds must not contain duplicate IDs.');
    if (strategy === 'DEPRIORITIZE_OTHER_DEMANDS' && ids.length === 0) {
      throw this.validationError('affectedInitiativeIds is required for DEPRIORITIZE_OTHER_DEMANDS.');
    }
    if (strategy !== 'DEPRIORITIZE_OTHER_DEMANDS' && ids.length > 0) {
      throw this.validationError('affectedInitiativeIds only applies to DEPRIORITIZE_OTHER_DEMANDS.');
    }
    return ids.sort();
  }

  private async lockActiveInitiatives(manager: EntityManager, ids: string[]) {
    if (ids.length === 0) return [];
    const initiatives = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .setLock('pessimistic_write')
      .where('initiative.id IN (:...ids) AND initiative.active = TRUE', { ids })
      .orderBy('initiative.id', 'ASC')
      .getMany();
    if (initiatives.length !== ids.length) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select active ITDMs for the Deprioritize other demands strategy.');
    }
    return initiatives.map((initiative) => ({ id: initiative.id, code: initiative.code, name: initiative.name }));
  }

  private normalizeUuid(value: string, field: string): string {
    if (!uuidPattern.test(value)) throw this.validationError(`${field} must be a UUID.`);
    return value.toLowerCase();
  }

  private normalizeBusinessDate(value: string, field: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw this.validationError(`${field} must be an ISO calendar date (YYYY-MM-DD).`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw this.validationError(`${field} must be a valid ISO calendar date.`);
    }
    return value;
  }

}
