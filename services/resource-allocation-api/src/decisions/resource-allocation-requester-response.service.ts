import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { requireAdminExceptionActor } from './exception-request-authorization';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import type { CancelDeniedRequestDto, ContestRequestDto } from './request-decision.dto';
import { ResourceAllocationDecisionSupport } from './resource-allocation-decision-support';

@Injectable()
export class ResourceAllocationRequesterResponseService extends ResourceAllocationDecisionSupport {
  constructor(@Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource, @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean) {
    super(dataSource, databaseConfigured);
  }

  private requireRequester(actor: ResourcePerson, item: ResourceRequest): void {
    if (actor.id !== item.requesterId) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only the requester may respond to this decision.');
    }
  }

  private async requireDeadlineNotReached(manager: EntityManager, dueAt: Date, code: string, detail: string): Promise<void> {
    const rows = await manager.query('SELECT clock_timestamp() >= $1::timestamptz AS passed', [dueAt]) as Array<{ passed: boolean }>;
    if (rows[0].passed) throw new ResourceAllocationException(code, 'Request deadline passed', 422, detail);
  }

  async contest(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: ContestRequestDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const explanation = this.normalizeReason(input.explanation, 'explanation');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
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
      throw translateResourceAllocationDatabaseError(error);
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
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason, 'reason');
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentForAuthorization = await this.lockRequest(manager, requestId);
        const exceptionCancellationOrReplay = ['PRE_N3', 'ESCALATION'].includes(currentForAuthorization.decisionState) ||
          currentForAuthorization.requesterId !== actor.id && currentForAuthorization.decisionState !== 'DENIED';
        if (actor.role === ResourceAllocationRole.Admin && exceptionCancellationOrReplay) {
          requireAdminExceptionActor(actor, currentForAuthorization);
          return runIdempotentOperation(manager, {
            actorId: actor.id,
            operation: 'request.exception.cancel',
            key: idempotencyKey,
            payload: { requestId, ifMatch: expectedVersion, reason },
          }, async () => {
            const item = await this.lockRequest(manager, requestId);
            requireAdminExceptionActor(actor, item);
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
      throw translateResourceAllocationDatabaseError(error);
    }
  }

}
