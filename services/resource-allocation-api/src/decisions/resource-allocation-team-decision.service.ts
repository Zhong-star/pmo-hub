import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import type { DenyRequestDto } from './request-decision.dto';
import { ResourceAllocationDecisionSupport } from './resource-allocation-decision-support';

const maximumBatchSize = 100;

@Injectable()
export class ResourceAllocationTeamDecisionService extends ResourceAllocationDecisionSupport {
  constructor(@Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource, @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean) {
    super(dataSource, databaseConfigured);
  }

  async deny(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: DenyRequestDto,
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
      throw translateResourceAllocationDatabaseError(error);
    }
  }

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
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private requireDecisionAccess(actor: ResourcePerson, item: ResourceRequest): void {
    if (item.requesterId === actor.id) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'A person cannot decide their own request.');
    }
    if (item.decisionState === 'REQUIRES_REVALIDATION' &&
      (item.revalidationOriginState === 'WAITING_FOR_PRESENTATION' || item.revalidationOriginState === 'PENDING_TEAM_DECISION')) {
      if (actor.role === ResourceAllocationRole.Admin) return;
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an Admin may decide a reference correction during revalidation.');
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

}
