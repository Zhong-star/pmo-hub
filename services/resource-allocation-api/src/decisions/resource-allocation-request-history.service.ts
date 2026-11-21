import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/opaque-cursor';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import type { RequestHistoryQueryDto } from './request-decision.dto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface RequestHistoryCursor {
  occurredAt: string;
  id: string;
}

@Injectable()
export class ResourceAllocationRequestHistoryService {
  constructor(@Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource, @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean) {
    this.dataSource = dataSource;
    this.databaseConfigured = databaseConfigured;
  }

  private readonly dataSource: DataSource;
  private readonly databaseConfigured: boolean;

  async getHistory(localUserId: string | undefined, requestId: string, query: RequestHistoryQueryDto) {
    this.ensureDatabaseAvailable();
    try {
      const actor = await this.requireActivePerson(this.dataSource.manager, localUserId);
      const item = await this.dataSource.getRepository(ResourceRequest).findOne({ where: { id: requestId } });
      if (!item || item.removedAt) throw this.notFound('Request');
      if (item.requesterId !== actor.id && !this.canConsultRequest(actor, item)) throw this.notFound('Request');

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
            ? encodeOpaqueCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
            : null,
          limit,
        },
      };
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  /** Additive worker hook. The deadline worker calls this alongside its waiting-request work. */

  private canConsultRequest(actor: ResourcePerson, item: ResourceRequest): boolean {
    if (actor.role === ResourceAllocationRole.Admin) return true;
    const groupId = this.groupId(item);
    if (!groupId) return false;
    return (actor.role === ResourceAllocationRole.Moderator && actor.groupId?.toLowerCase() === groupId)
      || ((actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager)
        && actor.coveredGroupIds.some((id) => id.toLowerCase() === groupId));
  }

  private groupId(item: ResourceRequest): string | undefined {
    const value = item.requestedConditions.groupId;
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
  }

  private decodeHistoryCursor(value: string): RequestHistoryCursor {
    try {
      const cursor = decodeOpaqueCursor<RequestHistoryCursor>(value);
      if (!cursor || !uuidPattern.test(cursor.id) || !cursor.occurredAt || Number.isNaN(Date.parse(cursor.occurredAt))) throw new Error('Invalid cursor.');
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for request history.');
    }
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

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }
}
