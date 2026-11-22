import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../../access/resource-allocation-problem';
import { ResourceAllocation } from '../../allocations/resource-allocation.entity';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../../database/database.module';
import { ResourceAllocationNotification } from '../../notifications/resource-allocation-notification.entity';
import { ResourceAllocationRole } from '../../people/resource-allocation-role';
import { ResourcePerson } from '../../people/resource-person.entity';
import { ResourceRequestHistory } from '../../requests/resource-request-history.entity';
import { ResourceRequest } from '../../requests/resource-request.entity';
import { ResourceSubmissionLine } from '../../submissions/resource-submission-line.entity';
import { ResourceAllocationOperationReceipt } from './resource-allocation-operation-receipt.entity';

export const supportedIdempotentOperations = [
  'submission.create',
  'admin.createPerson',
  'admin.createGroup',
  'admin.createResourceProfile',
  'admin.createInitiative',
  'request.withdraw',
  'request.refer',
  'request.correctReferences',
  'request.administrativeRemoval',
  'request.approve',
  'request.acceptChanges',
  'request.deny',
  'request.contestDenial',
  'request.exception.escalate',
  'request.exception.recordStrategy',
  'request.exception.resolve',
  'request.exception.cancel',
  'request.cancelDenied',
  'allocation.suspend',
  'allocation.reserve',
  'allocation.resume',
  'allocation.activate',
  'allocation.complete',
  'allocation.cancel',
  'notifications.mark-one-read',
  'notifications.mark-all-read',
] as const;

export type SupportedIdempotentOperation = typeof supportedIdempotentOperations[number];

const supportedOperationSet = new Set<string>(supportedIdempotentOperations);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const adminOnlyOperations = new Set<SupportedIdempotentOperation>([
  'admin.createPerson',
  'admin.createGroup',
  'admin.createResourceProfile',
  'admin.createInitiative',
  'request.refer',
  'request.correctReferences',
  'request.administrativeRemoval',
  'request.exception.escalate',
  'request.exception.recordStrategy',
  'request.exception.resolve',
  'request.exception.cancel',
]);

const nonSelfAdminRequestOperations = new Set<SupportedIdempotentOperation>([
  'request.administrativeRemoval',
  'request.exception.escalate',
  'request.exception.recordStrategy',
  'request.exception.resolve',
  'request.exception.cancel',
]);

const requesterRequestOperations = new Set<SupportedIdempotentOperation>([
  'request.withdraw',
  'request.acceptChanges',
  'request.contestDenial',
  'request.cancelDenied',
]);

const allocationOperations = new Set<SupportedIdempotentOperation>([
  'allocation.suspend',
  'allocation.reserve',
  'allocation.resume',
  'allocation.activate',
  'allocation.complete',
  'allocation.cancel',
]);

/** Looks up stored idempotent operation receipts for the owning active actor without re-executing mutations or emitting ETag. */
@Injectable()
export class ResourceAllocationOperationResultService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async getOperationResult(localUserId: string | undefined, attemptKey: string, operation: string | undefined) {
    this.ensureDatabaseAvailable();
    try {
      const actor = await this.requireActivePerson(localUserId);
      const normalizedOperation = operation?.trim();
      if (!normalizedOperation || !supportedOperationSet.has(normalizedOperation)) {
        throw this.validationError('operation must identify a supported idempotent Resource Allocation operation.');
      }

      const normalizedKey = attemptKey.toLowerCase();
      if (normalizedOperation === 'submission.create') {
        const line = await this.dataSource.getRepository(ResourceSubmissionLine).findOne({
          where: { requesterId: actor.id, attemptKey: normalizedKey },
        });
        if (line) return this.toSubmissionLineResponse(line);
      }

      const receipt = await this.dataSource.getRepository(ResourceAllocationOperationReceipt).findOne({
        where: { actorId: actor.id, operation: normalizedOperation, key: normalizedKey },
      });
      if (!receipt) throw this.notFound('Operation result');

      const storedResponse = receipt.responseBody as { value?: unknown } | null;
      const result = storedResponse && 'value' in storedResponse ? storedResponse.value : undefined;
      await this.authorizeOperationResult(actor, normalizedOperation as SupportedIdempotentOperation, result);
      return result;
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private async authorizeOperationResult(
    actor: ResourcePerson,
    operation: SupportedIdempotentOperation,
    result: unknown,
  ): Promise<void> {
    if (operation === 'submission.create' || operation === 'notifications.mark-all-read') return;

    if (operation === 'notifications.mark-one-read') {
      const notificationId = this.extractUuid(result, 'id');
      if (!notificationId) throw this.notFound('Operation result');
      const notification = await this.dataSource.getRepository(ResourceAllocationNotification).findOne({
        where: { id: notificationId, recipientId: actor.id },
        select: { id: true },
      });
      if (!notification) throw this.notFound('Operation result');
      return;
    }

    if (adminOnlyOperations.has(operation)) {
      if (actor.role !== ResourceAllocationRole.Admin) {
        throw this.accessDenied('Only an active Tech Resource Allocation Admin may access this operation result.');
      }
      if (nonSelfAdminRequestOperations.has(operation)) {
        const requestId = this.extractUuid(result, operation === 'request.administrativeRemoval' ? 'requestId' : 'id');
        if (!requestId) throw this.notFound('Operation result');
        const request = await this.dataSource.getRepository(ResourceRequest).findOne({
          where: { id: requestId },
          select: { id: true, requesterId: true, removedAt: true },
        });
        if (!request || (operation !== 'request.administrativeRemoval' && request.removedAt !== null)) {
          throw this.notFound('Operation result');
        }
        if (request.requesterId === actor.id) {
          throw this.accessDenied('A person cannot access an administrative decision on their own request.');
        }
      }
      return;
    }

    if (requesterRequestOperations.has(operation)) {
      const requestId = this.extractUuid(result, operation === 'request.withdraw' ? 'requestId' : 'id');
      if (!requestId) throw this.notFound('Operation result');
      const request = await this.dataSource.getRepository(ResourceRequest).findOne({
        where: { id: requestId },
        select: { id: true, requesterId: true, removedAt: true },
      });
      if (!request || (operation !== 'request.withdraw' && request.removedAt !== null)) {
        throw this.notFound('Operation result');
      }
      if (request.requesterId !== actor.id) {
        throw this.accessDenied('Only the requester may access this operation result.');
      }
      return;
    }

    if (operation === 'request.approve' || operation === 'request.deny') {
      const requestId = this.extractUuid(result, 'id');
      if (!requestId) throw this.notFound('Operation result');
      const request = await this.dataSource.getRepository(ResourceRequest).findOne({
        where: { id: requestId },
      });
      if (!request || request.removedAt !== null) throw this.notFound('Operation result');
      if (request.requesterId === actor.id) {
        throw this.accessDenied('A person cannot decide their own request.');
      }
      await this.requireCurrentDecisionScope(actor, request, operation === 'request.approve' ? 'APPROVED' : 'DENIED');
      return;
    }

    if (allocationOperations.has(operation)) {
      const allocationId = this.extractUuid(result, 'id');
      if (!allocationId) throw this.notFound('Operation result');
      const allocation = await this.dataSource.getRepository(ResourceAllocation).findOne({
        where: { id: allocationId },
        select: { id: true, personId: true, groupId: true },
      });
      if (!allocation) throw this.notFound('Operation result');
      if (!await this.canReadAllocation(actor, allocation.personId, allocation.groupId)) {
        throw this.accessDenied('The active profile is outside the allocation scope.');
      }
    }
  }

  private async requireCurrentDecisionScope(
    actor: ResourcePerson,
    request: ResourceRequest,
    action: 'APPROVED' | 'DENIED',
  ): Promise<void> {
    const actions = action === 'APPROVED' ? ['APPROVED', 'APPROVAL_CHANGES_PROPOSED'] : ['DENIED'];
    const latestDecision = await this.dataSource.getRepository(ResourceRequestHistory).createQueryBuilder('history')
      .where('history.request_id = :requestId AND history.action IN (:...actions)', { requestId: request.id, actions })
      .orderBy('history.occurred_at', 'DESC')
      .addOrderBy('history.id', 'DESC')
      .getOne();
    const snapshot = latestDecision?.afterSnapshot as {
      before?: {
        decisionState?: unknown;
        revalidationOriginState?: unknown;
        revalidationDecisionStage?: unknown;
      };
    } | undefined;
    const decision = snapshot?.before;
    if (!decision) throw this.notFound('Operation result');

    let decisionStage: 'WAITING_FOR_PRESENTATION' | 'PENDING_TEAM_DECISION';
    let adminOnly = false;
    if (decision.decisionState === 'WAITING_FOR_PRESENTATION') {
      decisionStage = 'WAITING_FOR_PRESENTATION';
      adminOnly = true;
    } else if (decision.decisionState === 'PENDING_TEAM_DECISION') {
      decisionStage = 'PENDING_TEAM_DECISION';
    } else if (decision.decisionState === 'REQUIRES_REVALIDATION') {
      if (decision.revalidationOriginState === 'WAITING_FOR_PRESENTATION' ||
        decision.revalidationOriginState === 'PENDING_TEAM_DECISION') {
        decisionStage = decision.revalidationOriginState;
        adminOnly = true;
      } else if (decision.revalidationOriginState === 'APPROVED_WITH_CHANGES') {
        decisionStage = decision.revalidationDecisionStage === 'WAITING_FOR_PRESENTATION'
          ? 'WAITING_FOR_PRESENTATION'
          : 'PENDING_TEAM_DECISION';
        adminOnly = decisionStage === 'WAITING_FOR_PRESENTATION';
      } else {
        throw this.notFound('Operation result');
      }
    } else {
      throw this.notFound('Operation result');
    }

    if (adminOnly) {
      if (actor.role === ResourceAllocationRole.Admin) return;
      throw this.accessDenied('Only an active Admin may access this decision receipt.');
    }
    if (decisionStage === 'WAITING_FOR_PRESENTATION') {
      if (actor.role === ResourceAllocationRole.Admin) return;
      throw this.accessDenied('The active role is no longer authorized for this presentation decision.');
    }

    const groupId = this.extractUuid(request.requestedConditions, 'groupId');
    const authorized = groupId !== undefined && (
      (actor.role === ResourceAllocationRole.Moderator && actor.groupId?.toLowerCase() === groupId) ||
      ((actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) &&
        actor.coveredGroupIds.some((id) => id.toLowerCase() === groupId)) ||
      (actor.role === ResourceAllocationRole.Admin && actor.groupId?.toLowerCase() === groupId)
    );
    if (!authorized) {
      throw this.accessDenied('The active profile no longer has access to this request group.');
    }
  }

  private async canReadAllocation(actor: ResourcePerson, personId: string, groupId: string): Promise<boolean> {
    if (actor.role === ResourceAllocationRole.Admin || actor.id.toLowerCase() === personId.toLowerCase()) return true;
    if (actor.role === ResourceAllocationRole.User) return false;
    if (actor.role === ResourceAllocationRole.Moderator) return actor.groupId?.toLowerCase() === groupId.toLowerCase();
    if (actor.role !== ResourceAllocationRole.Supervisor && actor.role !== ResourceAllocationRole.Manager) return false;
    const column = actor.role === ResourceAllocationRole.Supervisor ? 'supervisor_id' : 'manager_id';
    const rows = await this.dataSource.query(`
      SELECT (
        $3::uuid = ANY($2::uuid[]) OR EXISTS (
          SELECT 1 FROM resource_groups AS team WHERE team.id = $3::uuid AND team.${column} = $1::uuid
        )
      ) AS allowed
    `, [actor.id, actor.coveredGroupIds ?? [], groupId]) as Array<{ allowed: boolean }>;
    return rows[0]?.allowed === true;
  }

  private toSubmissionLineResponse(line: ResourceSubmissionLine) {
    return {
      id: line.id,
      attemptKey: line.attemptKey,
      submittedConditions: line.submittedConditions,
      status: line.status,
      ...(line.requestId ? { requestId: line.requestId } : {}),
      ...(line.problem ? { problem: line.problem } : {}),
      receivedAt: line.receivedAt.toISOString(),
      ...(line.completedAt ? { completedAt: line.completedAt.toISOString() } : {}),
      ...(line.requestOutcome ? { requestOutcome: line.requestOutcome } : {}),
    };
  }

  private extractUuid(value: unknown, field: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === 'string' && uuidPattern.test(candidate) ? candidate.toLowerCase() : undefined;
  }

  private async requireActivePerson(localUserId: string | undefined): Promise<ResourcePerson> {
    if (process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED === 'false' ||
      (process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true')) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before accessing operation results.');
    }
    const actor = await this.dataSource.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) {
      throw this.accessDenied('An active Tech Resource Allocation profile is required.');
    }
    return actor;
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private accessDenied(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, detail);
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

}
