import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { allocationResponse } from '../allocations/allocation-response';
import { createResourceAllocationForRequest } from '../allocations/create-resource-allocation-for-request';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import type { CancelDeniedRequestDto, ContestRequestDto, DenyRequestDto, RequestHistoryQueryDto } from './request-decision.dto';
import { resolutionStrategies, type RecordRequestStrategyDto, type ResolutionStrategy, type ResolveRequestExceptionDto } from './resolve-exception.dto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumBatchSize = 100;

interface RequestHistoryCursor {
  occurredAt: string;
  id: string;
}

@Injectable()
export class ResourceAllocationDecisionService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async deny(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: DenyRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const explanation = this.normalizeReason(input.explanation, 'explanation');
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentForAuthorization = await this.lockRequest(manager, requestId);
        await this.requireCurrentDecisionScope(manager, actor, currentForAuthorization);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.deny',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, explanation },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          this.requireDecisionAccess(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION', 'REQUIRES_REVALIDATION'], 'Only a request awaiting a decision or revalidation can be denied.');
          if (item.decisionState === 'WAITING_FOR_PRESENTATION') {
            await this.requireDeadlineNotPassed(manager, item.expirationDueAt, 'PRESENTATION_DEADLINE_PASSED', 'The 21-day presentation deadline has passed.');
          }

          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          item.decisionState = 'DENIED';
          item.revalidationOriginState = null;
          item.revalidationDecisionStage = null;
          item.stageEnteredAt = occurredAt;
          item.expirationDueAt = new Date(occurredAt.getTime() + 14 * 24 * 60 * 60 * 1000);
          const saved = await manager.getRepository(ResourceRequest).save(item);
          await this.recordHistory(manager, saved, actor, 'DENIED', before, this.snapshot(saved), explanation, correlation, occurredAt);
          await this.notifyRecipients(manager, [saved.requesterId], actor.id, saved, `REQUEST_DENIED_${saved.version}`, 'Resource request denied', 'A decision maker denied your resource request. Review the explanation in the request history.', occurredAt);
          return this.toResponse(saved);
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async contest(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: ContestRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const explanation = this.normalizeReason(input.explanation, 'explanation');
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentForAuthorization = await this.lockRequest(manager, requestId);
        this.requireRequester(actor, currentForAuthorization);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.contestDenial',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, explanation },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          this.requireRequester(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['DENIED', 'APPROVED_WITH_CHANGES'], 'Only a denied request or a changed proposal may be contested.');
          if (item.decisionState === 'APPROVED_WITH_CHANGES') {
            if (!item.decisionResponseDueAt) {
              throw new ResourceAllocationException('REQUEST_DECISION_NOT_ALLOWED', 'Request cannot be contested', 422, 'This proposal has no active response deadline.');
            }
            await this.requireDeadlineNotReached(manager, item.decisionResponseDueAt, 'PROPOSAL_RESPONSE_EXPIRED', 'The proposal response deadline has been reached.');
          } else {
            await this.requireDeadlineNotPassed(manager, item.expirationDueAt, 'DENIAL_RESPONSE_EXPIRED', 'The 14-day response deadline has passed.');
          }

          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          item.decisionState = 'PRE_N3';
          item.stageEnteredAt = occurredAt;
          item.decisionResponseDueAt = null;
          const saved = await manager.getRepository(ResourceRequest).save(item);
          await this.recordHistory(manager, saved, actor, 'CONTESTED', before, this.snapshot(saved), explanation, correlation, occurredAt);
          const admins = await this.activeAdminIds(manager);
          await this.notifyRecipients(manager, admins, actor.id, saved, `REQUEST_CONTESTED_${saved.version}`, 'Resource request contested', 'A requester contested a denied request. Review it in the Pre N3 queue.', occurredAt);
          return this.toResponse(saved);
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async escalate(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CancelDeniedRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const current = await this.lockRequest(manager, requestId);
        this.requireAdminExceptionActor(actor, current);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.exception.escalate',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, reason },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          this.requireAdminExceptionActor(actor, item);
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
      throw this.translateDatabaseError(error);
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
    const expectedVersion = this.parseIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = this.requireCorrelationId(correlationId);
    const strategy = this.normalizeStrategy(input.strategy);
    const affectedIds = this.normalizeAffectedInitiativeIds(strategy, input.affectedInitiativeIds);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const current = await this.lockRequest(manager, requestId);
        this.requireAdminExceptionActor(actor, current);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.exception.recordStrategy',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, strategy, reason, affectedInitiativeIds: affectedIds },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          this.requireAdminExceptionActor(actor, item);
          this.requireVersion(item, expectedVersion);
          this.requireState(item, ['PRE_N3', 'ESCALATION'], 'A resolution strategy can only be recorded for Pre N3 or Escalation.');
          const affectedInitiatives = await this.lockActiveInitiatives(manager, strategy, affectedIds);
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
      throw this.translateDatabaseError(error);
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
    const expectedVersion = this.parseIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = this.requireCorrelationId(correlationId);
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
        this.requireAdminExceptionActor(actor, current);
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
          this.requireAdminExceptionActor(actor, item);
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
          const affectedInitiatives = await this.lockActiveInitiatives(manager, strategy, affectedIds);
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
      throw this.translateDatabaseError(error);
    }
  }

  async cancelDenied(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CancelDeniedRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentForAuthorization = await this.lockRequest(manager, requestId);
        const exceptionCancellationOrReplay = ['PRE_N3', 'ESCALATION'].includes(currentForAuthorization.decisionState) ||
          currentForAuthorization.requesterId !== actor.id && currentForAuthorization.decisionState !== 'DENIED';
        if (actor.role === ResourceAllocationRole.Admin && exceptionCancellationOrReplay) {
          this.requireAdminExceptionActor(actor, currentForAuthorization);
          return runIdempotentOperation(manager, {
            actorId: actor.id,
            operation: 'request.exception.cancel',
            key: idempotencyKey,
            payload: { requestId, ifMatch: expectedVersion, reason },
          }, async () => {
            const item = await this.lockRequest(manager, requestId);
            this.requireAdminExceptionActor(actor, item);
            this.requireVersion(item, expectedVersion);
            this.requireState(item, ['PRE_N3', 'ESCALATION'], 'Only a Pre N3 or Escalation request may be cancelled by an Admin.');
            const occurredAt = await this.currentTimestamp(manager);
            const before = this.snapshot(item);
            item.decisionState = 'CANCELLED';
            item.stageEnteredAt = occurredAt;
            const saved = await manager.getRepository(ResourceRequest).save(item);
            await this.recordHistory(manager, saved, actor, 'EXCEPTION_CANCELLED', before, this.snapshot(saved), reason, correlation, occurredAt);
            const leaders = await this.groupLeaderIds(manager, this.groupId(saved));
            await this.notifyRecipients(manager, [saved.requesterId, ...leaders], actor.id, saved, `REQUEST_EXCEPTION_CANCELLED_${saved.version}`, 'Resource request cancelled', 'An Admin cancelled the contested resource request.', occurredAt);
            return this.toResponse(saved);
          });
        }
        this.requireRequester(actor, currentForAuthorization);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.cancelDenied',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, reason },
        }, async () => {
          const item = await this.lockRequest(manager, requestId);
          this.requireRequester(actor, item);
          this.requireVersion(item, expectedVersion);
          const isRevalidation = item.decisionState === 'REQUIRES_REVALIDATION';
          this.requireState(item, ['DENIED', 'REQUIRES_REVALIDATION'], 'Only the requester may cancel a denied or revalidating request.');
          if (!isRevalidation) {
            await this.requireDeadlineNotPassed(manager, item.expirationDueAt, 'DENIAL_RESPONSE_EXPIRED', 'The 14-day response deadline has passed.');
          }

          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          item.decisionState = 'CANCELLED';
          item.revalidationOriginState = null;
          item.revalidationDecisionStage = null;
          item.stageEnteredAt = occurredAt;
          const saved = await manager.getRepository(ResourceRequest).save(item);
          await this.recordHistory(manager, saved, actor, isRevalidation ? 'REVALIDATION_CANCELLED' : 'DENIAL_CANCELLED', before, this.snapshot(saved), reason, correlation, occurredAt);
          const leaders = await this.groupLeaderIds(manager, this.groupId(saved));
          await this.notifyRecipients(manager, leaders, actor.id, saved, `REQUEST_${isRevalidation ? 'REVALIDATION' : 'DENIAL'}_CANCELLED_${saved.version}`, 'Resource request cancelled', isRevalidation ? 'The requester cancelled a request that needed eligibility review.' : 'The requester cancelled a denied resource request.', occurredAt);
          return this.toResponse(saved);
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async getHistory(localUserId: string | undefined, requestId: string, query: RequestHistoryQueryDto) {
    this.ensureDatabaseAvailable();
    try {
      const actor = await this.requireActivePerson(this.dataSource.manager, localUserId);
      const item = await this.dataSource.getRepository(ResourceRequest).findOne({
        where: { id: requestId, requesterId: actor.id },
      });
      if (!item || item.removedAt) throw this.notFound('Request');

      const limit = query.limit ?? 50;
      const cursor = query.cursor ? this.decodeHistoryCursor(query.cursor) : undefined;
      const builder = this.dataSource.getRepository(ResourceRequestHistory).createQueryBuilder('history')
        .where('history.request_id = :requestId', { requestId });
      if (cursor) {
        builder.andWhere('(history.occurred_at, history.id) > (:occurredAt, :id)', {
          occurredAt: cursor.occurredAt,
          id: cursor.id,
        });
      }
      const found = await builder.orderBy('history.occurred_at', 'ASC').addOrderBy('history.id', 'ASC').take(limit + 1).getMany();
      const selected = found.slice(0, limit);
      const last = selected[selected.length - 1];
      const historyRepository = this.dataSource.getRepository(ResourceRequestHistory);
      const latestDenial = await historyRepository.findOne({
        where: { requestId, action: 'DENIED' },
        order: { occurredAt: 'DESC', id: 'DESC' },
      });
      const latestResponse = await historyRepository.createQueryBuilder('history')
        .where('history.request_id = :requestId AND history.action IN (:...actions)', {
          requestId,
          actions: ['CONTESTED', 'DENIAL_CANCELLED', 'DENIAL_AUTO_CANCELLED'],
        })
        .orderBy('history.occurred_at', 'DESC')
        .addOrderBy('history.id', 'DESC')
        .getOne();
      return {
        items: selected.map((event) => this.toHistoryResponse(event)),
        latestDenial: latestDenial ? this.toHistoryResponse(latestDenial) : null,
        latestResponse: latestResponse ? this.toHistoryResponse(latestResponse) : null,
        page: {
          nextCursor: found.length > limit && last
            ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt.toISOString(), id: last.id })).toString('base64url')
            : null,
          limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  /** Additive worker hook. The deadline worker calls this alongside its waiting-request work. */
  async expireDeniedRequests(batchSize = maximumBatchSize): Promise<number> {
    this.ensureDatabaseAvailable();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize) {
      throw this.validationError(`batchSize must be between 1 and ${maximumBatchSize}.`);
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const due = await manager.query(`
          SELECT id
          FROM resource_requests
          WHERE decision_state = 'DENIED'
            AND removed_at IS NULL
            AND expiration_due_at < clock_timestamp()
          ORDER BY expiration_due_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        `, [batchSize]) as Array<{ id: string }>;
        let expired = 0;
        for (const row of due) {
          const item = await manager.getRepository(ResourceRequest).findOne({ where: { id: row.id } });
          if (!item || item.removedAt || item.decisionState !== 'DENIED') continue;
          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(item);
          item.decisionState = 'CANCELLED';
          item.stageEnteredAt = occurredAt;
          const saved = await manager.getRepository(ResourceRequest).save(item);
          const reason = 'Automatic cancellation: no response within 14 days of the denial.';
          await this.recordSystemHistory(manager, saved, 'DENIAL_AUTO_CANCELLED', before, this.snapshot(saved), reason, randomUUID(), occurredAt);
          const leaders = await this.groupLeaderIds(manager, this.groupId(saved));
          await this.notifyRecipients(manager, [saved.requesterId, ...leaders], undefined, saved, `REQUEST_DENIAL_EXPIRED_${saved.version}`, 'Resource request cancelled', 'The request was cancelled because the requester did not respond within 14 days.', occurredAt);
          expired += 1;
        }
        return expired;
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async lockRequest(manager: EntityManager, requestId: string): Promise<ResourceRequest> {
    const item = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :requestId AND request.removed_at IS NULL', { requestId })
      .getOne();
    if (!item) throw this.notFound('Request');
    return item;
  }

  private async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
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

  private requireDecisionAccess(actor: ResourcePerson, item: ResourceRequest): void {
    if (item.requesterId === actor.id) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'A person cannot decide their own request.');
    }
    if (item.decisionState === 'REQUIRES_REVALIDATION') {
      if (item.revalidationOriginState === 'WAITING_FOR_PRESENTATION' || item.revalidationOriginState === 'PENDING_TEAM_DECISION') {
        if (actor.role === ResourceAllocationRole.Admin) return;
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an Admin may decide a reference correction during revalidation.');
      }
    }
    const decisionState = item.decisionState === 'REQUIRES_REVALIDATION'
      ? item.revalidationDecisionStage === 'WAITING_FOR_PRESENTATION' ? 'WAITING_FOR_PRESENTATION' : 'PENDING_TEAM_DECISION'
      : item.decisionState;
    if (decisionState === 'WAITING_FOR_PRESENTATION' && actor.role === ResourceAllocationRole.Admin) return;
    const groupId = this.groupId(item);
    if (!groupId) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The request does not have a valid group decision scope.');
    }
    const authorized = decisionState === 'PENDING_TEAM_DECISION' && (
      (actor.role === ResourceAllocationRole.Moderator && actor.groupId === groupId) ||
      ((actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) && actor.coveredGroupIds.includes(groupId)) ||
      (actor.role === ResourceAllocationRole.Admin && actor.groupId === groupId)
    );
    if (!authorized) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The active role is not authorized to deny this request in the current queue scope.');
    }
  }

  private async requireCurrentDecisionScope(manager: EntityManager, actor: ResourcePerson, item: ResourceRequest): Promise<void> {
    let decisionState = item.decisionState;
    if (decisionState === 'REQUIRES_REVALIDATION') {
      decisionState = item.revalidationOriginState === 'WAITING_FOR_PRESENTATION'
        ? 'WAITING_FOR_PRESENTATION'
        : 'PENDING_TEAM_DECISION';
    } else if (decisionState !== 'WAITING_FOR_PRESENTATION' && decisionState !== 'PENDING_TEAM_DECISION') {
      const events = await manager.getRepository(ResourceRequestHistory).createQueryBuilder('history')
        .where('history.request_id = :requestId AND history.action = :action', { requestId: item.id, action: 'DENIED' })
        .orderBy('history.occurred_at', 'DESC')
        .addOrderBy('history.id', 'DESC')
        .take(1)
        .getMany();
      const snapshot = events[0]?.afterSnapshot as { before?: { decisionState?: unknown } } | undefined;
      const priorState = snapshot?.before?.decisionState;
      if (priorState === 'WAITING_FOR_PRESENTATION' || priorState === 'PENDING_TEAM_DECISION') decisionState = priorState;
    }
    this.requireDecisionAccess(actor, item.decisionState === 'REQUIRES_REVALIDATION' ? item : { ...item, decisionState });
  }

  private requireRequester(actor: ResourcePerson, item: ResourceRequest): void {
    if (actor.id !== item.requesterId) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only the requester may respond to this decision.');
    }
  }

  private requireVersion(item: ResourceRequest, expectedVersion: number): void {
    if (item.version !== expectedVersion) {
      throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before continuing.');
    }
  }

  private requireState(item: ResourceRequest, allowed: string[], detail: string): void {
    if (!allowed.includes(item.decisionState)) {
      throw new ResourceAllocationException('REQUEST_DECISION_NOT_ALLOWED', 'Request decision is not allowed', 422, detail);
    }
  }

  private async requireDeadlineNotPassed(manager: EntityManager, dueAt: Date, code: string, detail: string): Promise<void> {
    const rows = await manager.query('SELECT clock_timestamp() > $1::timestamptz AS passed', [dueAt]) as Array<{ passed: boolean }>;
    if (rows[0].passed) {
      throw new ResourceAllocationException(code, 'Request deadline passed', 422, detail);
    }
  }

  private async requireDeadlineNotReached(manager: EntityManager, dueAt: Date, code: string, detail: string): Promise<void> {
    const rows = await manager.query('SELECT clock_timestamp() >= $1::timestamptz AS passed', [dueAt]) as Array<{ passed: boolean }>;
    if (rows[0].passed) {
      throw new ResourceAllocationException(code, 'Request deadline passed', 422, detail);
    }
  }

  private async currentTimestamp(manager: EntityManager): Promise<Date> {
    const rows = await manager.query('SELECT clock_timestamp() AS now') as Array<{ now: Date | string }>;
    return new Date(rows[0].now);
  }

  private async recordHistory(
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

  private async recordSystemHistory(
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

  private async activeAdminIds(manager: EntityManager): Promise<string[]> {
    const rows = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .select('person.id', 'id')
      .where('person.active = TRUE AND person.role = :role', { role: ResourceAllocationRole.Admin })
      .orderBy('person.id', 'ASC')
      .getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  private async groupLeaderIds(manager: EntityManager, groupId: string | undefined): Promise<string[]> {
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

  private async notifyRecipients(
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

  private async requireActivePersonOutsideTransaction(localUserId: string | undefined): Promise<ResourcePerson> {
    this.ensureDatabaseAvailable();
    try {
      return await this.requireActivePerson(this.dataSource.manager, localUserId);
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private parseIfMatch(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw this.validationError('A single strong If-Match version is required.');
    return Number(match[1]);
  }

  private requireCorrelationId(value: string | undefined): string {
    if (!value || !uuidPattern.test(value)) throw this.validationError('A valid X-Correlation-ID is required.');
    return value.toLowerCase();
  }

  private normalizeReason(value: string, field: string): string {
    if (typeof value !== 'string') throw this.validationError(`${field} is required.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 2000) throw this.validationError(`${field} must contain between 1 and 2000 characters.`);
    return normalized;
  }

  private requireAdminExceptionActor(actor: ResourcePerson, item: ResourceRequest): void {
    if (actor.role !== ResourceAllocationRole.Admin) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Admin may resolve exception requests.');
    }
    if (item.requesterId === actor.id) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An Admin cannot resolve their own request.');
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

  private async lockActiveInitiatives(manager: EntityManager, strategy: ResolutionStrategy, ids: string[]) {
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
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw this.validationError(`${field} must be a UUID.`);
    return value.toLowerCase();
  }

  private normalizeBusinessDate(value: string, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw this.validationError(`${field} must be an ISO calendar date (YYYY-MM-DD).`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw this.validationError(`${field} must be a valid ISO calendar date.`);
    }
    return value;
  }

  private toResponse(item: ResourceRequest) {
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

  private toHistoryResponse(event: ResourceRequestHistory) {
    const snapshot = event.afterSnapshot as { before?: unknown; after?: unknown; reason?: unknown };
    return {
      id: event.id,
      action: event.action,
      actorSnapshot: event.actorSnapshot,
      before: snapshot.before && typeof snapshot.before === 'object' ? snapshot.before : {},
      after: snapshot.after && typeof snapshot.after === 'object' ? snapshot.after : event.afterSnapshot,
      reason: typeof snapshot.reason === 'string' ? snapshot.reason : null,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
    };
  }

  private snapshot(item: ResourceRequest): Record<string, unknown> {
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

  private actorSnapshot(actor: ResourcePerson) {
    return { personId: actor.id, displayName: actor.displayName, role: actor.role };
  }

  private groupId(item: ResourceRequest): string | undefined {
    const value = item.requestedConditions.groupId;
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
  }

  private decodeHistoryCursor(value: string): RequestHistoryCursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as RequestHistoryCursor;
      if (!cursor || !uuidPattern.test(cursor.id) || !cursor.occurredAt || Number.isNaN(Date.parse(cursor.occurredAt))) throw new Error('Invalid cursor.');
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for request history.');
    }
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
