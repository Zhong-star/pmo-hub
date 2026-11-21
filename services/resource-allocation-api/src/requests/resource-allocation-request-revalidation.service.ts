import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { markInitiativeUsedForRequest } from '../initiatives/mark-initiative-used';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { ResourceAllocationRequestCommandSupport } from './resource-allocation-request-queue-support';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceRequest } from './resource-request.entity';
import type { CorrectRequestReferencesDto } from './request-queue.dto';

@Injectable()
export class ResourceAllocationRequestRevalidationService extends ResourceAllocationRequestCommandSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean,
  ) {
    super(dataSource, databaseConfigured);
  }

  async correctReferences(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CorrectRequestReferencesDto,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const correction = this.normalizeReferenceCorrection(input);
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.correctReferences',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, correction },
        }, async () => {
          const request = await this.lockRequest(manager, requestId);
          this.requireVersion(request, expectedVersion);
          this.requireState(request, ['WAITING_FOR_PRESENTATION', 'REQUIRES_REVALIDATION', 'PRE_N3', 'ESCALATION'], 'References can only be corrected while a request waits for presentation, revalidation, or exception resolution.');
          if (request.decisionState === 'WAITING_FOR_PRESENTATION') await this.requireCurrentWaitingDeadline(manager, request);
          if (correction.personId && !['PRE_N3', 'ESCALATION'].includes(request.decisionState)) {
            throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Person cannot be corrected', 422, 'A person may be corrected directly only during Pre N3 or Escalation resolution.');
          }
          const before = this.snapshot(request);
          const prior = request.requestedConditions;
          const { personId, ...referenceCorrection } = correction;
          const next = this.applyReferenceCorrection(prior, referenceCorrection);
          const references = await this.requireActiveReferences(manager, next);
          const correctedPerson = personId
            ? await manager.getRepository(ResourcePerson).findOne({ where: { id: personId, active: true, groupId: references.group.id } })
            : null;
          if (personId && !correctedPerson) {
            throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active person assigned to the corrected request group.');
          }
          if (correction.initiativeId) {
            next.initiativeId = references.initiative.id;
            next.initiativeCode = references.initiative.code;
            next.initiativeName = references.initiative.name;
          }
          if (correction.groupId) {
            next.groupId = references.group.id;
            next.groupName = references.group.name;
          }
          if (correction.resourceProfileId) {
            next.resourceProfileId = references.profile.id;
            next.resourceProfileName = references.profile.name;
          }
          if (correction.initiativeId && correction.initiativeId !== this.readUuid(prior.initiativeId)) {
            await markInitiativeUsedForRequest(manager, references.initiative.id);
          }
          request.requestedConditions = next;
          if (request.approvedConditions || correctedPerson) {
            const approved = this.applyReferenceCorrection(request.approvedConditions ?? next, referenceCorrection);
            if (correction.initiativeId) {
              approved.initiativeId = references.initiative.id;
              approved.initiativeCode = references.initiative.code;
              approved.initiativeName = references.initiative.name;
            }
            if (correction.groupId) {
              approved.groupId = references.group.id;
              approved.groupName = references.group.name;
            }
            if (correction.resourceProfileId) {
              approved.resourceProfileId = references.profile.id;
              approved.resourceProfileName = references.profile.name;
            }
            if (correctedPerson) {
              approved.personId = correctedPerson.id;
              approved.personName = correctedPerson.displayName;
            }
            request.approvedConditions = approved;
          }
          const occurredAt = await this.currentTimestamp(manager);
          const saved = await manager.getRepository(ResourceRequest).save(request);
          await this.recordHistory(manager, saved, actor, 'REFERENCE_CORRECTED', before, this.snapshot(saved), correlation, occurredAt, correction.reason);
          const recipients = saved.decisionState === 'WAITING_FOR_PRESENTATION'
            ? [saved.requesterId]
            : [saved.requesterId, ...(await this.getActiveGroupLeaderIds(manager, saved))];
          await this.notifyMany(manager, recipients.map((recipientId) => ({
            recipientId,
            requestId: saved.id,
            eventCode: `REQUEST_REFERENCE_CORRECTED_${saved.version}`,
            title: 'Resource request references updated',
            message: 'An Admin corrected the references on your request. Review its current status in Tech Resource Allocation.',
            createdAt: occurredAt,
          })).filter((notice) => notice.recipientId !== actor.id));
          return this.toRequestResponse(saved);
        });
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private async getActiveGroupLeaderIds(manager: EntityManager, request: ResourceRequest): Promise<string[]> {
    const groupId = this.readUuid(request.requestedConditions.groupId);
    if (!groupId) return [];
    const leaders = await manager.query(`
      SELECT DISTINCT person.id
      FROM resource_people AS person
      LEFT JOIN resource_groups AS request_group ON request_group.id = $1
      WHERE person.active = TRUE
        AND (
          (person.role IN ($2, $3) AND person.group_id = $1)
          OR person.id = request_group.supervisor_id
          OR person.id = request_group.manager_id
        )
    `, [groupId, ResourceAllocationRole.Moderator, ResourceAllocationRole.Admin]) as Array<{ id: string }>;
    return leaders.map((leader) => leader.id);
  }

  private normalizeReferenceCorrection(input: CorrectRequestReferencesDto) {
    const corrected: { personId?: string; initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string } = {
      reason: this.normalizeReason(input.reason),
    };
    const personId = this.normalizeOptionalUuid(input.personId, 'personId');
    const initiativeId = this.normalizeOptionalUuid(input.initiativeId, 'initiativeId');
    const groupId = this.normalizeOptionalUuid(input.groupId, 'groupId');
    const resourceProfileId = this.normalizeOptionalUuid(input.resourceProfileId, 'resourceProfileId');
    if (personId) corrected.personId = personId;
    if (initiativeId) corrected.initiativeId = initiativeId;
    if (groupId) corrected.groupId = groupId;
    if (resourceProfileId) corrected.resourceProfileId = resourceProfileId;
    if (!personId && !initiativeId && !groupId && !resourceProfileId) {
      throw this.validationError('Provide at least one reference to correct.');
    }
    return corrected;
  }

  private normalizeOptionalUuid(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw this.validationError(`${field} must be a UUID.`);
    }
    return value.toLowerCase();
  }

  private applyReferenceCorrection(
    prior: Record<string, unknown>,
    correction: { initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string },
  ): Record<string, unknown> {
    return { ...prior,
      ...(correction.initiativeId ? { initiativeId: correction.initiativeId } : {}),
      ...(correction.groupId ? { groupId: correction.groupId } : {}),
      ...(correction.resourceProfileId ? { resourceProfileId: correction.resourceProfileId } : {}),
    };
  }


}
