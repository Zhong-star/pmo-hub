import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, In, IsNull, type EntityManager } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LocalAccessService, type LocalProfile } from '../local-access.service';
import type { CreateLessonCommentRequest } from './create-lesson-comment-request.dto';
import type { HideLessonCommentRequest } from './hide-lesson-comment-request.dto';
import type {
  LessonCommentItemResponse,
  LessonCommentPageResponse,
  LessonCommentThreadResponse,
} from './lesson-comment-response.dto';
import { LessonComment } from './lesson-comment.entity';
import {
  formatNotificationSnippet,
  LessonNotificationsService,
} from './lesson-notifications.service';
import { Lesson } from './lesson.entity';

interface CommentCursor {
  scope: string;
  key: string;
  id: number;
}

function parseLimit(limit?: string): number {
  if (limit === undefined) return 50;
  if (typeof limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(limit)) {
    throw new BadRequestException('Page limit must be an integer between 1 and 100.');
  }
  return Number(limit);
}

function parseIncludeHidden(includeHidden?: string): boolean {
  if (includeHidden === undefined || includeHidden === 'false') return false;
  if (includeHidden === 'true') return true;
  throw new BadRequestException('Set includeHidden to true or false.');
}

function decodeCommentCursor(cursor: string, scope: string): CommentCursor {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CommentCursor>;
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
    return decoded as CommentCursor;
  } catch {
    throw new BadRequestException('Invalid cursor for this comment query.');
  }
}

function encodeCommentCursor(scope: string, key: string, id: number): string {
  const scopeHash = createHash('sha256').update(scope).digest('hex');
  return Buffer.from(JSON.stringify({ scope: scopeHash, key, id })).toString('base64url');
}

@Injectable()
export class LessonCommentsService {
  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
    @Optional() @Inject(LessonNotificationsService) private readonly notifications?: LessonNotificationsService,
  ) {}

  async listComments(
    localUserId: string | undefined,
    lessonId: number,
    options: { cursor?: string; limit?: string; includeHidden?: string } = {},
  ): Promise<LessonCommentPageResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const includeHidden = parseIncludeHidden(options.includeHidden);
    if (includeHidden && profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to view hidden comments.');
    }
    const limit = parseLimit(options.limit);
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      await this.requireAccessibleLesson(manager, lessonId, profile);

      const scope = `comments:${lessonId}:${includeHidden ? 'audit' : 'public'}`;
      const cursorKey = '(EXTRACT(EPOCH FROM comment.created_at) * 1000000)::bigint';
      const rootQuery = manager
        .getRepository(LessonComment)
        .createQueryBuilder('comment')
        .where('comment.lesson_id = :lessonId', { lessonId })
        .andWhere('comment.parent_comment_id IS NULL');

      if (!includeHidden) {
        rootQuery.andWhere(
          `(comment.hidden_at IS NULL OR EXISTS (
            SELECT 1 FROM lesson_comments reply
            WHERE reply.parent_comment_id = comment.id
              AND reply.hidden_at IS NULL
          ))`,
        );
      }

      if (options.cursor !== undefined) {
        const decoded = decodeCommentCursor(options.cursor, scope);
        rootQuery.andWhere(`(${cursorKey}, comment.id) < (CAST(:pageKey AS bigint), :pageId)`, {
          pageKey: decoded.key,
          pageId: decoded.id,
        });
      }

      const { raw, entities } = await rootQuery
        .addSelect(cursorKey, 'comment_cursor_key')
        .orderBy('comment_cursor_key', 'DESC')
        .addOrderBy('comment.id', 'DESC')
        .limit(limit + 1)
        .getRawAndEntities<{ comment_cursor_key: string }>();

      const hasMore = entities.length > limit;
      const pageRoots = entities.slice(0, limit);
      const nextCursor = hasMore
        ? encodeCommentCursor(scope, raw[limit - 1].comment_cursor_key, pageRoots[limit - 1].id)
        : null;

      const rootIds = pageRoots.map((comment) => comment.id);
      const repliesByParent = new Map<number, LessonComment[]>();
      if (rootIds.length > 0) {
        const replies = await manager.getRepository(LessonComment).find({
          where: includeHidden
            ? { parentCommentId: In(rootIds) }
            : { parentCommentId: In(rootIds), hiddenAt: IsNull() },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        for (const reply of replies) {
          if (reply.parentCommentId === null) continue;
          const bucket = repliesByParent.get(reply.parentCommentId) ?? [];
          bucket.push(reply);
          repliesByParent.set(reply.parentCommentId, bucket);
        }
      }

      const countRows = await manager.query(
        'SELECT COUNT(*)::int AS count FROM lesson_comments WHERE lesson_id = $1 AND hidden_at IS NULL',
        [lessonId],
      ) as { count: number | string }[];
      const publicCommentCount = Number(countRows[0]?.count ?? 0);

      const items: LessonCommentThreadResponse[] = pageRoots.map((root) => ({
        ...this.toCommentItemResponse(root, includeHidden),
        replies: (repliesByParent.get(root.id) ?? []).map((reply) =>
          this.toCommentItemResponse(reply, includeHidden),
        ),
      }));

      return {
        items,
        page: { limit, nextCursor },
        publicCommentCount,
      };
    });
  }

  async createComment(
    localUserId: string | undefined,
    lessonId: number,
    input: CreateLessonCommentRequest,
  ): Promise<LessonCommentThreadResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    const { lesson, created } = await dataSource.transaction(async (manager) => {
      const accessibleLesson = await this.requireAccessibleLesson(manager, lessonId, profile);
      const repo = manager.getRepository(LessonComment);
      const savedComment = await repo.save(
        repo.create({
          lessonId,
          parentCommentId: null,
          authorUserId: profile.id,
          authorDisplayName: profile.displayName,
          body: input.body,
          hiddenAt: null,
          hiddenByUserId: null,
          hiddenByDisplayName: null,
          hiddenReason: null,
        }),
      );
      return { lesson: accessibleLesson, created: savedComment };
    });

    await this.notifications?.recordNotification({
      recipientUserId: lesson.authorId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType: 'COMMENT_ADDED',
      lessonId: lesson.id,
      lessonTitleSnapshot: lesson.title,
      summary: `${profile.displayName} commented: ${formatNotificationSnippet(created.body)}`,
      sourceEventKey: `comment:${created.id}`,
    });

    return {
      ...this.toCommentItemResponse(created, false),
      replies: [],
    };
  }

  async createReply(
    localUserId: string | undefined,
    lessonId: number,
    parentCommentId: number,
    input: CreateLessonCommentRequest,
  ): Promise<LessonCommentItemResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    const { lesson, parent, created } = await dataSource.transaction(async (manager) => {
      const accessibleLesson = await this.requireAccessibleLesson(manager, lessonId, profile);
      const repo = manager.getRepository(LessonComment);
      const parentComment = await repo.findOne({ where: { id: parentCommentId, lessonId } });
      if (!parentComment) {
        throw new NotFoundException('Comment not found.');
      }
      if (parentComment.parentCommentId !== null) {
        throw new BadRequestException({
          code: 'REPLY_DEPTH_EXCEEDED',
          message: 'Replies can only be added to top-level comments.',
        });
      }
      if (parentComment.hiddenAt !== null) {
        throw new ConflictException({
          code: 'COMMENT_HIDDEN',
          message: 'Cannot reply to a hidden comment.',
        });
      }

      const savedReply = await repo.save(
        repo.create({
          lessonId,
          parentCommentId: parentComment.id,
          authorUserId: profile.id,
          authorDisplayName: profile.displayName,
          body: input.body,
          hiddenAt: null,
          hiddenByUserId: null,
          hiddenByDisplayName: null,
          hiddenReason: null,
        }),
      );
      return { lesson: accessibleLesson, parent: parentComment, created: savedReply };
    });

    await this.notifications?.recordNotification({
      recipientUserId: parent.authorUserId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType: 'REPLY_ADDED',
      lessonId: lesson.id,
      lessonTitleSnapshot: lesson.title,
      summary: `${profile.displayName} replied: ${formatNotificationSnippet(created.body)}`,
      sourceEventKey: `comment:${created.id}`,
    });

    return this.toCommentItemResponse(created, false);
  }

  async hideComment(
    localUserId: string | undefined,
    lessonId: number,
    commentId: number,
    input: HideLessonCommentRequest,
  ): Promise<LessonCommentItemResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to hide comments.');
    }
    const dataSource = this.requireDataSource();

    const hidden = await dataSource.transaction(async (manager) => {
      const lesson = await manager.getRepository(Lesson).findOne({ where: { id: lessonId } });
      if (!lesson) {
        throw new NotFoundException('Lesson not found.');
      }
      const repo = manager.getRepository(LessonComment);
      const comment = await repo.findOne({
        where: { id: commentId, lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!comment) {
        throw new NotFoundException('Comment not found.');
      }
      if (comment.hiddenAt !== null) {
        throw new ConflictException({
          code: 'COMMENT_ALREADY_HIDDEN',
          message: 'This comment is already hidden.',
        });
      }

      comment.hiddenAt = new Date();
      comment.hiddenByUserId = profile.id;
      comment.hiddenByDisplayName = profile.displayName;
      comment.hiddenReason = input.reason.trim();
      return repo.save(comment);
    });

    return this.toCommentItemResponse(hidden, true);
  }

  private async requireAccessibleLesson(
    manager: EntityManager,
    lessonId: number,
    profile: LocalProfile,
  ): Promise<Lesson> {
    const lesson = await manager.getRepository(Lesson).findOne({ where: { id: lessonId } });
    const isPmo = profile.role === 'LESSONS_MODERATOR';
    const isAuthor = lesson?.authorId === profile.id;
    const isPublished = lesson?.approvedAt !== null
      && (lesson?.status === 'Approved' || lesson?.status === 'Closed');
    if (!lesson || (!isPmo && !isAuthor && !isPublished)) {
      throw new NotFoundException('Lesson not found.');
    }
    return lesson;
  }

  private toCommentItemResponse(
    comment: LessonComment,
    includeModerationAudit: boolean,
  ): LessonCommentItemResponse {
    const isHidden = comment.hiddenAt !== null;
    if (isHidden && !includeModerationAudit) {
      return {
        id: comment.id,
        lessonId: comment.lessonId,
        parentCommentId: comment.parentCommentId,
        authorId: null,
        authorDisplayName: null,
        body: null,
        createdAt: comment.createdAt,
        isHidden: true,
        moderation: null,
      };
    }

    return {
      id: comment.id,
      lessonId: comment.lessonId,
      parentCommentId: comment.parentCommentId,
      authorId: comment.authorUserId,
      authorDisplayName: comment.authorDisplayName,
      body: comment.body,
      createdAt: comment.createdAt,
      isHidden,
      moderation: isHidden && comment.hiddenAt
        ? {
            hiddenAt: comment.hiddenAt,
            hiddenByUserId: comment.hiddenByUserId ?? '',
            hiddenByDisplayName: comment.hiddenByDisplayName ?? comment.hiddenByUserId ?? '',
            reason: comment.hiddenReason ?? '',
          }
        : null,
    };
  }

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
  }
}
