import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const LESSON_NOTIFICATION_EVENT_TYPES = [
  'LESSON_RETURNED',
  'LESSON_APPROVED',
  'LESSON_REJECTED',
  'COMMENT_ADDED',
  'REPLY_ADDED',
] as const;

export type LessonNotificationEventType = (typeof LESSON_NOTIFICATION_EVENT_TYPES)[number];

@Entity({ name: 'lesson_notifications' })
export class LessonNotification {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id!: number;

  @Column({ name: 'recipient_user_id', type: 'varchar', length: 128 })
  recipientUserId!: string;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 128 })
  actorUserId!: string;

  @Column({ name: 'actor_display_name', type: 'varchar', length: 200 })
  actorDisplayName!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 40 })
  eventType!: LessonNotificationEventType;

  @Column({ name: 'lesson_id', type: 'integer' })
  lessonId!: number;

  @Column({ name: 'lesson_title_snapshot', type: 'varchar', length: 200 })
  lessonTitleSnapshot!: string;

  @Column({ name: 'summary', type: 'varchar', length: 500 })
  summary!: string;

  @Column({ name: 'source_event_key', type: 'varchar', length: 128 })
  sourceEventKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;
}
