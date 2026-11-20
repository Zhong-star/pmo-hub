import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LessonNotification, type LessonNotificationEventType } from './lesson-notification.entity';

export function countUnreadNotifications(manager: EntityManager, recipientUserId: string): Promise<number> {
  return manager.getRepository(LessonNotification).countBy({ recipientUserId, readAt: IsNull() });
}

export interface RecordLessonNotificationInput {
  recipientUserId: string;
  actorUserId: string;
  actorDisplayName: string;
  eventType: LessonNotificationEventType;
  lessonId: number;
  lessonTitleSnapshot: string;
  summary: string;
  sourceEventKey: string;
}

@Injectable()
export class LessonNotificationStore {
  constructor(
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async insertNotification(input: RecordLessonNotificationInput): Promise<void> {
    if (!this.dataSource) {
      throw new Error('Lessons Learned persistence is unavailable.');
    }

    await this.dataSource.query(
      `INSERT INTO lesson_notifications (
        recipient_user_id,
        actor_user_id,
        actor_display_name,
        event_type,
        lesson_id,
        lesson_title_snapshot,
        summary,
        source_event_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (recipient_user_id, event_type, source_event_key) DO NOTHING`,
      [
        input.recipientUserId,
        input.actorUserId,
        input.actorDisplayName.slice(0, 200),
        input.eventType,
        input.lessonId,
        input.lessonTitleSnapshot.slice(0, 200),
        input.summary.slice(0, 500),
        input.sourceEventKey.slice(0, 128),
      ],
    );
  }
}
