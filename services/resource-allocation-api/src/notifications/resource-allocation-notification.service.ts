import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocationAccessService } from '../access/resource-allocation-access.service';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../database/database.module';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { ResourceNotificationDto } from './resource-allocation-notification.dto';

const defaultPageSize = 50;
const maximumPageSize = 100;
const cursorVersion = 1;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const targetAvailableSql = `CASE
  WHEN source_request.id IS NULL OR source_request.removed_at IS NOT NULL THEN FALSE
  WHEN source_request.requester_id = recipient.id THEN TRUE
  WHEN source_allocation.person_id = recipient.id THEN TRUE
  WHEN recipient.role = 'ALLOCATION_ADMIN' THEN TRUE
  WHEN recipient.role = 'ALLOCATION_MODERATOR' AND recipient.group_id = source_group.id THEN TRUE
  WHEN recipient.role = 'ALLOCATION_SUPERVISOR' AND (
    recipient.covered_group_ids @> ARRAY[source_group.id]::uuid[] OR source_group.supervisor_id = recipient.id
  ) THEN TRUE
  WHEN recipient.role = 'ALLOCATION_MANAGER' AND (
    recipient.covered_group_ids @> ARRAY[source_group.id]::uuid[] OR source_group.manager_id = recipient.id
  ) THEN TRUE
  ELSE FALSE
END`;
const targetDestinationSql = `CASE
  WHEN NOT (${targetAvailableSql}) THEN NULL
  WHEN source_request.requester_id = recipient.id THEN 'REQUEST_DETAIL'
  WHEN source_allocation.id IS NOT NULL THEN 'ALLOCATION_DETAIL'
  WHEN recipient.role = 'ALLOCATION_ADMIN' AND source_request.decision_state = 'WAITING_FOR_PRESENTATION' THEN 'PRESENTATION_QUEUE'
  WHEN recipient.role = 'ALLOCATION_ADMIN' AND source_request.decision_state = 'PENDING_TEAM_DECISION' THEN 'TEAM_DECISION_QUEUE'
  WHEN recipient.role = 'ALLOCATION_ADMIN' THEN 'REQUEST_DETAIL'
  WHEN source_request.decision_state = 'PENDING_TEAM_DECISION' THEN 'TEAM_DECISION_QUEUE'
  ELSE NULL
END`;

interface NotificationCursor {
  version: number;
  kind: 'notifications';
  read: boolean | null;
  createdAt: string;
  id: string;
}

interface NotificationRow {
  id: string;
  event_code: string;
  title: string;
  message: string;
  created_at: string;
  cursor_created_at: string;
  read_at: string | null;
  source_request_id: string;
  target_available: boolean;
  target_destination: 'REQUEST_DETAIL' | 'PRESENTATION_QUEUE' | 'TEAM_DECISION_QUEUE' | 'ALLOCATION_DETAIL' | null;
  allocation_id: string | null;
  etag?: string;
}

interface PageQuery {
  read?: string;
  limit?: string;
  cursor?: string;
}

@Injectable()
export class ResourceAllocationNotificationService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(ResourceAllocationAccessService)
    private readonly accessService: ResourceAllocationAccessService,
  ) {}

  async list(localUserId: string | undefined, query: PageQuery) {
    const access = await this.accessService.getAccess(localUserId);
    const page = this.parsePage(query);
    try {
      const parameters: unknown[] = [access.person.id];
      const clauses = ['notification.recipient_id = $1::uuid', 'recipient.active = TRUE'];
      if (page.read !== null) {
        parameters.push(page.read);
        clauses.push(`(notification.read_at IS NOT NULL) = $${parameters.length}::boolean`);
      }
      if (page.after) {
        parameters.push(page.after.createdAt, page.after.id);
        clauses.push(`(notification.created_at, notification.id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
      }
      parameters.push(page.limit + 1);
      const rows = await this.dataSource.query(`
        SELECT
          notification.id::text AS id,
          notification.event_code,
          notification.title,
          notification.message,
          to_char(notification.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          to_char(notification.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
          to_char(notification.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
          notification.source_request_id::text AS source_request_id,
          source_allocation.id::text AS allocation_id,
          ${targetAvailableSql} AS target_available,
          ${targetDestinationSql} AS target_destination
        FROM resource_allocation_notifications AS notification
        INNER JOIN resource_people AS recipient ON recipient.id = notification.recipient_id
        LEFT JOIN resource_requests AS source_request ON source_request.id = notification.source_request_id
        LEFT JOIN resource_allocations AS source_allocation ON source_allocation.source_request_id = source_request.id
        LEFT JOIN resource_groups AS source_group
          ON source_group.id = NULLIF(source_request.requested_conditions->>'groupId', '')::uuid
        WHERE ${clauses.join(' AND ')}
        ORDER BY notification.created_at DESC, notification.id DESC
        LIMIT $${parameters.length}::int
      `, parameters) as NotificationRow[];
      const hasNext = rows.length > page.limit;
      const items = rows.slice(0, page.limit).map((row) => this.toNotification(row));
      const lastRow = rows[page.limit - 1];
      return {
        items,
        page: {
          nextCursor: hasNext && lastRow
            ? this.encodeCursor({
              version: cursorVersion,
              kind: 'notifications',
              read: page.read,
              createdAt: lastRow.cursor_created_at,
              id: lastRow.id,
            })
            : null,
          limit: page.limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async markOne(
    localUserId: string | undefined,
    notificationId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    const access = await this.accessService.getAccess(localUserId);
    const expectedEtag = this.parseIfMatch(ifMatch);
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const operation = await runIdempotentOperation(manager, {
          actorId: access.person.id,
          operation: 'notifications.mark-one-read',
          key: idempotencyKey,
          payload: { notificationId: notificationId.toLowerCase() },
        }, async () => {
          const current = await this.findNotification(manager, access.person.id, notificationId, true);
          if (!current) throw this.notFound();
          if (current.etag !== expectedEtag) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The notification changed. Reload it before marking it as read.');
          }
          if (current.readAt === null) {
            await manager.query(`
              UPDATE resource_allocation_notifications
              SET read_at = clock_timestamp()
              WHERE id = $1::uuid AND recipient_id = $2::uuid AND read_at IS NULL
            `, [notificationId, access.person.id]);
          }
          const updated = await this.findNotification(manager, access.person.id, notificationId);
          if (!updated) throw this.notFound();
          return updated;
        });
        if (operation.replayed) {
          const current = await this.findNotification(manager, access.person.id, notificationId);
          if (!current) throw this.notFound();
          return current;
        }
        return operation.result;
      });
      return result;
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async markAll(localUserId: string | undefined, idempotencyKey: string | undefined) {
    const access = await this.accessService.getAccess(localUserId);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const operation = await runIdempotentOperation(manager, {
          actorId: access.person.id,
          operation: 'notifications.mark-all-read',
          key: idempotencyKey,
          payload: {},
        }, async () => {
          const rows = await manager.query(`
            WITH cutoff AS MATERIALIZED (
              SELECT clock_timestamp() AS confirmed_at
            ),
            marked AS (
              UPDATE resource_allocation_notifications AS notification
              SET read_at = cutoff.confirmed_at
              FROM cutoff, resource_people AS recipient
              WHERE recipient.id = $1::uuid
                AND recipient.active = TRUE
                AND notification.recipient_id = recipient.id
                AND notification.read_at IS NULL
                AND notification.created_at <= cutoff.confirmed_at
              RETURNING notification.id
            )
            SELECT to_char(cutoff.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at,
                   COUNT(marked.id)::int AS marked_count
            FROM cutoff LEFT JOIN marked ON TRUE
            GROUP BY cutoff.confirmed_at
          `, [access.person.id]) as Array<{ confirmed_at: string; marked_count: number }>;
          const result = rows[0];
          if (!result) throw new Error('Notification read cutoff was not returned.');
          return {
            cutoffAt: result.confirmed_at,
            markedCount: Number(result.marked_count),
          };
        });
        return operation.result;
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  etag(notification: ResourceNotificationDto): string {
    return notification.etag;
  }

  private toNotification(row: NotificationRow): ResourceNotificationDto {
    const notification: Omit<ResourceNotificationDto, 'etag'> = {
      id: row.id,
      eventCode: row.event_code,
      title: row.title,
      message: row.message,
      createdAt: row.created_at,
      readAt: row.read_at,
      target: {
        type: 'REQUEST',
        requestId: row.source_request_id,
        available: row.target_available,
        destination: row.target_destination,
        allocationId: row.target_destination === 'ALLOCATION_DETAIL' ? row.allocation_id : null,
      },
    };
    return {
      ...notification,
      etag: `"${createHash('sha256').update(JSON.stringify(notification)).digest('hex').slice(0, 24)}"`,
    };
  }

  private async findNotification(
    manager: EntityManager,
    recipientId: string,
    notificationId: string,
    lock = false,
  ): Promise<ResourceNotificationDto | undefined> {
    const rows = await manager.query(`
      SELECT
        notification.id::text AS id,
        notification.event_code,
        notification.title,
        notification.message,
        to_char(notification.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        to_char(notification.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
        to_char(notification.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
        notification.source_request_id::text AS source_request_id,
        source_allocation.id::text AS allocation_id,
        ${targetAvailableSql} AS target_available,
        ${targetDestinationSql} AS target_destination
      FROM resource_allocation_notifications AS notification
      INNER JOIN resource_people AS recipient
        ON recipient.id = notification.recipient_id AND recipient.active = TRUE
      LEFT JOIN resource_requests AS source_request ON source_request.id = notification.source_request_id
      LEFT JOIN resource_allocations AS source_allocation ON source_allocation.source_request_id = source_request.id
      LEFT JOIN resource_groups AS source_group
        ON source_group.id = NULLIF(source_request.requested_conditions->>'groupId', '')::uuid
      WHERE notification.recipient_id = $1::uuid AND notification.id = $2::uuid
      ${lock ? 'FOR UPDATE OF notification' : ''}
    `, [recipientId, notificationId]) as NotificationRow[];
    return rows[0] ? this.toNotification(rows[0]) : undefined;
  }

  private parsePage(query: PageQuery): { read: boolean | null; limit: number; after?: NotificationCursor } {
    let read: boolean | null = null;
    if (query.read !== undefined) {
      if (query.read !== 'true' && query.read !== 'false') throw this.validationError('read must be either true or false.');
      read = query.read === 'true';
    }
    let limit = defaultPageSize;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit)) throw this.validationError('limit must be an integer from 1 to 100.');
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) {
        throw this.validationError('limit must be an integer from 1 to 100.');
      }
    }
    const after = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    if (after && after.read !== read) throw this.validationError('cursor is invalid for the current read filter.');
    return { read, limit, ...(after ? { after } : {}) };
  }

  private decodeCursor(value: string): NotificationCursor {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Not an object.');
      const candidate = parsed as Partial<NotificationCursor>;
      if (candidate.version !== cursorVersion || candidate.kind !== 'notifications' ||
        !(candidate.read === null || typeof candidate.read === 'boolean') ||
        typeof candidate.createdAt !== 'string' || !timestampPattern.test(candidate.createdAt) ||
        Number.isNaN(Date.parse(candidate.createdAt)) || typeof candidate.id !== 'string' || !uuidPattern.test(candidate.id)) {
        throw new Error('Invalid cursor shape.');
      }
      return candidate as NotificationCursor;
    } catch {
      throw this.validationError('cursor is invalid.');
    }
  }

  private encodeCursor(cursor: NotificationCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private notFound(): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, 'The notification was not found for this user.');
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private parseIfMatch(value: string | undefined): string {
    if (!value || !/^"[a-f0-9]{24}"$/i.test(value)) {
      throw this.validationError('A single strong If-Match ETag from the current notification is required.');
    }
    return value;
  }

  private translateDatabaseError(error: unknown): unknown {
    if (error instanceof ResourceAllocationException) return error;
    if (isDatabaseUnavailable(error)) {
      return new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
        'The Resource Allocation database is unavailable.', undefined, error,
      );
    }
    return new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}
