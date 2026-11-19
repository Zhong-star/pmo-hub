import { ApiProperty } from '@nestjs/swagger';
import {
  LESSON_NOTIFICATION_EVENT_TYPES,
  type LessonNotificationEventType,
} from './lesson-notification.entity';

export class LessonNotificationItemResponse {
  @ApiProperty({ type: Number, example: 1 })
  id!: number;

  @ApiProperty({ type: String, enum: LESSON_NOTIFICATION_EVENT_TYPES, example: 'LESSON_APPROVED' })
  eventType!: LessonNotificationEventType;

  @ApiProperty({ type: String, example: 'local-pmo' })
  actorUserId!: string;

  @ApiProperty({ type: String, example: 'Local PMO' })
  actorDisplayName!: string;

  @ApiProperty({ type: Number, example: 42 })
  lessonId!: number;

  @ApiProperty({ type: String, example: 'Release checklist alignment' })
  lessonTitle!: string;

  @ApiProperty({ type: String, example: 'Local PMO approved your lesson.' })
  summary!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: Date | null;

  @ApiProperty({ type: Boolean, example: false })
  isRead!: boolean;
}

export class LessonNotificationPageMetadataResponse {
  @ApiProperty({ type: Number, example: 20 })
  limit!: number;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class LessonNotificationPageResponse {
  @ApiProperty({ type: [LessonNotificationItemResponse] })
  items!: LessonNotificationItemResponse[];

  @ApiProperty({ type: LessonNotificationPageMetadataResponse })
  page!: LessonNotificationPageMetadataResponse;

  @ApiProperty({ type: Number, example: 3 })
  unreadCount!: number;
}

export class MarkNotificationReadResponse {
  @ApiProperty({ type: LessonNotificationItemResponse })
  notification!: LessonNotificationItemResponse;

  @ApiProperty({ type: Number, example: 2 })
  unreadCount!: number;
}

export class MarkNotificationsReadBatchResponse {
  @ApiProperty({ type: [Number], example: [1, 2] })
  updatedIds!: number[];

  @ApiProperty({ type: Number, example: 1 })
  unreadCount!: number;
}
