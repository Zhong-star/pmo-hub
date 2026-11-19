import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LocalAccessService } from '../local-access.service';
import type {
  LessonNotificationItemResponse,
  LessonNotificationPageResponse,
  MarkNotificationReadResponse,
  MarkNotificationsReadBatchResponse,
} from './lesson-notification-response.dto';
import {
  countUnreadNotifications,
  LessonNotificationStore,
  type RecordLessonNotificationInput,
} from './lesson-notification-store';
import { LessonNotification } from './lesson-notification.entity';
import type { MarkNotificationsReadBatchRequest } from './mark-notifications-read-batch-request.dto';

interface NotificationCursor {
  scope: string;
  key: string;
  id: number;
}

function parseLimit(limit?: string): number {
  if (limit === undefined) return 20;
  if (typeof limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(limit)) {
    throw new BadRequestException('Page limit must be an integer between 1 and 100.');
  }
  return Number(limit);
}

function decodeNotificationCursor(cursor: string, scope: string): NotificationCursor {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<NotificationCursor>;
    const scopeHash = createHash('sha256').update(scope).digest('hex');
    if (
      decoded.scope !== scopeHash ||
      typeof decoded.key !== 'string' ||
      !/^-?[0-9]{1,19}$/.test(decoded.key) ||
      BigInt(decoded.key) > 9223372036854775807n ||
      BigInt(decoded.key) < -9223372036854775808n ||
      typeof decoded.id !== 'number' ||
      !Number.isInteger(decoded.id) ||
      decoded.id < 1 ||
      decoded.id > 2147483647
    ) {
      throw new Error();
    }
    return decoded as NotificationCursor;
  } catch {
    throw new BadRequestException('Invalid cursor for this notification query.');
  }
}

function encodeNotificationCursor(scope: string, key: string, id: number): string {
  const scopeHash = createHash('sha256').update(scope).digest('hex');
  return Buffer.from(JSON.stringify({ scope: scopeHash, key, id })).toString('base64url');
}

export function formatNotificationSnippet(text: string, maxLength = 160): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

@Injectable()
export class LessonNotificationsService {
  private readonly logger = new Logger(LessonNotificationsService.name);

  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Inject(LessonNotificationStore) private readonly store: LessonNotificationStore,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async recordNotification(input: RecordLessonNotificationInput): Promise<void> {
    if (input.actorUserId === input.recipientUserId) {
      return;
    }

    try {
      await this.store.insertNotification(input);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'lesson_notification_persistence_failed',
          recipientUserId: input.recipientUserId,
          actorUserId: input.actorUserId,
          eventType: input.eventType,
          lessonId: input.lessonId,
          sourceEventKey: input.sourceEventKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async listNotifications(
    localUserId: string | undefined,
    options: { cursor?: string; limit?: string } = {},
  ): Promise<LessonNotificationPageResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const limit = parseLimit(options.limit);
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const scope = `notifications:${profile.id}`;
      const cursorKey = '(EXTRACT(EPOCH FROM notification.created_at) * 1000000)::bigint';
      const query = manager
        .getRepository(LessonNotification)
        .createQueryBuilder('notification')
        .where('notification.recipient_user_id = :recipientUserId', { recipientUserId: profile.id });

      if (options.cursor !== undefined) {
        const decoded = decodeNotificationCursor(options.cursor, scope);
        query.andWhere(`(${cursorKey}, notification.id) < (CAST(:pageKey AS bigint), :pageId)`, {
          pageKey: decoded.key,
          pageId: decoded.id,
        });
      }

      const { raw, entities } = await query
        .addSelect(cursorKey, 'notification_cursor_key')
        .orderBy('notification_cursor_key', 'DESC')
        .addOrderBy('notification.id', 'DESC')
        .limit(limit + 1)
        .getRawAndEntities<{ notification_cursor_key: string }>();

      const hasMore = entities.length > limit;
      const pageItems = entities.slice(0, limit);
      const nextCursor = hasMore
        ? encodeNotificationCursor(scope, raw[limit - 1].notification_cursor_key, pageItems[limit - 1].id)
        : null;

      const unreadCount = await countUnreadNotifications(manager, profile.id);

      return {
        items: pageItems.map((item) => this.toItemResponse(item)),
        page: { limit, nextCursor },
        unreadCount,
      };
    });
  }

  async markAsRead(
    localUserId: string | undefined,
    notificationId: number,
  ): Promise<MarkNotificationReadResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(LessonNotification);
      const notification = await repo.findOne({
        where: { id: notificationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!notification) {
        throw new NotFoundException('Notification not found.');
      }
      if (notification.recipientUserId !== profile.id) {
        throw new ForbiddenException('You can only access your own notifications.');
      }

      if (notification.readAt === null) {
        notification.readAt = new Date();
        await repo.save(notification);
      }

      const unreadCount = await countUnreadNotifications(manager, profile.id);

      return {
        notification: this.toItemResponse(notification),
        unreadCount,
      };
    });
  }

  async markBatchAsRead(
    localUserId: string | undefined,
    input: MarkNotificationsReadBatchRequest,
  ): Promise<MarkNotificationsReadBatchResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const uniqueIds = Array.from(new Set(input.notificationIds));
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(LessonNotification);
      const notifications = await repo.find({
        where: { id: In(uniqueIds) },
        lock: { mode: 'pessimistic_write' },
      });

      const foundById = new Map(notifications.map((item) => [item.id, item]));
      for (const id of uniqueIds) {
        const item = foundById.get(id);
        if (!item) {
          throw new NotFoundException('One or more notifications were not found.');
        }
        if (item.recipientUserId !== profile.id) {
          throw new ForbiddenException('You can only mark your own notifications as read.');
        }
      }

      const now = new Date();
      const updatedIds: number[] = [];
      for (const item of notifications) {
        if (item.readAt === null) {
          item.readAt = now;
          updatedIds.push(item.id);
        }
      }

      if (updatedIds.length > 0) {
        await repo.save(notifications.filter((item) => updatedIds.includes(item.id)));
      }

      const unreadCount = await countUnreadNotifications(manager, profile.id);

      return {
        updatedIds,
        unreadCount,
      };
    });
  }

  private toItemResponse(notification: LessonNotification): LessonNotificationItemResponse {
    return {
      id: notification.id,
      eventType: notification.eventType,
      actorUserId: notification.actorUserId,
      actorDisplayName: notification.actorDisplayName,
      lessonId: notification.lessonId,
      lessonTitle: notification.lessonTitleSnapshot,
      summary: notification.summary,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
      isRead: notification.readAt !== null,
    };
  }

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
  }
}
