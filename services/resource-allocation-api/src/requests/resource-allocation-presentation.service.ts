import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { removeResourceRequest } from './remove-resource-request';
import { ResourceAllocationRequestCommandSupport } from './resource-allocation-request-queue-support';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceRequest } from './resource-request.entity';
import type { AdministrativeRequestRemovalDto, ReferRequestDto } from './request-queue.dto';

@Injectable()
export class ResourceAllocationPresentationService extends ResourceAllocationRequestCommandSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean,
  ) {
    super(dataSource, databaseConfigured);
  }

  async refer(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    _input: ReferRequestDto,
  ) {
    // The request body is intentionally empty; the controller rejects unknown fields.
    void _input;
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.refer',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion },
        }, async () => {
          const request = await this.lockRequest(manager, requestId);
          this.requireVersion(request, expectedVersion);
          this.requireState(request, ['WAITING_FOR_PRESENTATION', 'REQUIRES_REVALIDATION'], 'Only a request waiting for presentation or revalidation can be referred.');
          if (request.decisionState === 'WAITING_FOR_PRESENTATION') await this.requireCurrentWaitingDeadline(manager, request);
          if (request.decisionState === 'REQUIRES_REVALIDATION' && !['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION'].includes(request.revalidationOriginState ?? '')) {
            throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request cannot be referred', 422, 'Only a request originally waiting for presentation or team decision can be referred.');
          }
          const { group } = await this.requireActiveReferences(manager, request.requestedConditions);
          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(request);
          request.decisionState = 'PENDING_TEAM_DECISION';
          request.revalidationOriginState = null;
          request.revalidationDecisionStage = null;
          request.stageEnteredAt = occurredAt;
          const saved = await manager.getRepository(ResourceRequest).save(request);
          await this.recordHistory(manager, saved, actor, 'REFERRED', before, this.snapshot(saved), correlation, occurredAt);
          await this.notifyGroupLeaders(manager, group, saved, actor, occurredAt);
          return this.toRequestResponse(saved);
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async removeAdministratively(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: AdministrativeRequestRemovalDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason);
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.administrativeRemoval',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, reason },
        }, async () => {
          const resourceRequest = await this.lockRequest(manager, requestId);
          this.requireVersion(resourceRequest, expectedVersion);
          if (resourceRequest.requesterId === actor.id) {
            throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An Admin cannot remove their own request.');
          }
          this.requireState(resourceRequest, ['WAITING_FOR_PRESENTATION'], 'Only a request waiting for presentation can be removed administratively.');
          await this.requireCurrentWaitingDeadline(manager, resourceRequest);
          const audit = await removeResourceRequest(manager, {
            request: resourceRequest,
            action: 'ADMIN_REMOVED',
            actorSnapshot: this.actorSnapshot(actor),
            reason,
            correlationId: correlation,
          });
          await this.notify(manager, {
            recipientId: resourceRequest.requesterId,
            requestId: resourceRequest.id,
            eventCode: 'REQUEST_ADMIN_REMOVED',
            title: 'Resource request removed',
            message: 'An Admin removed your request from the active queue. Its audit record is retained.',
            createdAt: audit.occurredAt,
          });
          return {
            requestId: resourceRequest.id,
            action: 'ADMIN_REMOVED' as const,
            removedAt: audit.occurredAt.toISOString(),
          };
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private async notifyGroupLeaders(
    manager: EntityManager,
    group: ResourceGroup,
    resourceRequest: ResourceRequest,
    actor: ResourcePerson,
    createdAt: Date,
  ): Promise<void> {
    const leaders = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .where('person.active = TRUE')
      .andWhere('((person.role = :moderator AND person.groupId = :groupId) OR (person.role = :admin AND person.groupId = :groupId) OR person.id = :supervisorId OR person.id = :managerId)', {
        moderator: ResourceAllocationRole.Moderator,
        admin: ResourceAllocationRole.Admin,
        groupId: group.id,
        supervisorId: group.supervisorId ?? '00000000-0000-4000-8000-000000000000',
        managerId: group.managerId ?? '00000000-0000-4000-8000-000000000000',
      })
      .getMany();
    const recipients = new Map(leaders
      .filter((person) => person.id !== actor.id && person.id !== resourceRequest.requesterId)
      .map((person) => [person.id, person]));
    await this.notifyMany(manager, [...recipients.keys()].map((recipientId) => ({
      recipientId,
      requestId: resourceRequest.id,
      eventCode: `REQUEST_REFERRED_${resourceRequest.version}`,
      title: 'Resource request referred to your group',
      message: 'A request is waiting for a decision from your group.',
      createdAt,
    })));
  }


}
