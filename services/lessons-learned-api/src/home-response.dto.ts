import { ApiProperty } from '@nestjs/swagger';
import { LESSON_STATUSES, LESSON_TYPES, type LessonStatus, type LessonType } from './lessons/lesson-domain.constants';
import { LessonNotificationItemResponse } from './lessons/lesson-notification-response.dto';

export const HOME_PRIMARY_ACTION_KINDS = [
  'review-returned',
  'continue-draft',
  'evaluate-pending',
  'create-lesson',
  'explore-library',
] as const;
export type HomePrimaryActionKind = typeof HOME_PRIMARY_ACTION_KINDS[number];

export const HOME_TARGET_PAGES = [
  'home',
  'my-submissions',
  'pmo-drafts',
  'evaluation-queue',
  'pmo-dashboard',
  'library',
  'profiles',
  'create-lesson',
] as const;
export type HomeTargetPage = typeof HOME_TARGET_PAGES[number];

export class LessonsLearnedProfile {
  @ApiProperty({ type: String, example: 'local-contributor' })
  id!: string;

  @ApiProperty({ type: String, example: 'Local Contributor' })
  displayName!: string;

  @ApiProperty({ type: String, enum: ['LESSONS_USER', 'LESSONS_MODERATOR'], example: 'LESSONS_USER' })
  role!: 'LESSONS_USER' | 'LESSONS_MODERATOR';
}

export class LessonsLearnedNavigationItem {
  @ApiProperty({ type: String, example: 'home' })
  id!: 'home';

  @ApiProperty({ type: String, example: 'Home' })
  label!: 'Home';

  @ApiProperty({ type: Boolean, example: true })
  current!: true;
}

export class HomeNotificationsSummary {
  @ApiProperty({ type: Number, minimum: 0, example: 2 })
  unreadCount!: number;

  @ApiProperty({ type: () => [LessonNotificationItemResponse] })
  items!: LessonNotificationItemResponse[];
}

export class HomeLessonSummary {
  @ApiProperty({ type: Number, example: 42 })
  id!: number;

  @ApiProperty({ type: String, example: 'Release checklist alignment' })
  title!: string;

  @ApiProperty({ type: String, enum: LESSON_STATUSES, example: 'Open' })
  status!: LessonStatus;

  @ApiProperty({ type: String, example: 'local-contributor' })
  authorId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Local Contributor' })
  authorName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Core Platform' })
  projectName!: string | null;

  @ApiProperty({ type: String, enum: LESSON_TYPES, nullable: true, example: 'Future Prevention' })
  lessonType!: LessonType | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, example: 'Clarify root cause details.' })
  latestReviewGuidance!: string | null;

  @ApiProperty({ type: Boolean, example: false })
  isReturned!: boolean;
}

export class HomeHighlights {
  @ApiProperty({ type: Number, minimum: 0, example: 1 })
  returnedCount!: number;

  @ApiProperty({ type: () => [HomeLessonSummary] })
  returnedLessons!: HomeLessonSummary[];

  @ApiProperty({ type: Number, minimum: 0, example: 1 })
  openDraftCount!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  pendingEvaluationCount!: number;

  @ApiProperty({ type: () => [HomeLessonSummary] })
  pendingEvaluationLessons!: HomeLessonSummary[];
}

export class HomePrimaryAction {
  @ApiProperty({ type: String, enum: HOME_PRIMARY_ACTION_KINDS, example: 'create-lesson' })
  kind!: HomePrimaryActionKind;

  @ApiProperty({ type: String, example: 'Create lesson' })
  label!: string;

  @ApiProperty({ type: String, example: 'Capture your first lesson learned to share with the team.' })
  description!: string;

  @ApiProperty({ type: String, enum: HOME_TARGET_PAGES, example: 'create-lesson' })
  targetPage!: HomeTargetPage;

  @ApiProperty({ type: Number, nullable: true, example: null })
  lessonId!: number | null;
}

export class HomeShortcut {
  @ApiProperty({ type: String, enum: HOME_TARGET_PAGES, example: 'library' })
  id!: HomeTargetPage;

  @ApiProperty({ type: String, example: 'Lessons Library' })
  label!: string;

  @ApiProperty({ type: String, example: 'Search and explore published lessons.' })
  description!: string;

  @ApiProperty({ type: String, enum: HOME_TARGET_PAGES, example: 'library' })
  targetPage!: HomeTargetPage;
}

export class LessonsLearnedHomeResponse {
  @ApiProperty({ type: () => LessonsLearnedProfile })
  profile!: LessonsLearnedProfile;

  @ApiProperty({ type: () => [LessonsLearnedNavigationItem] })
  navigation!: LessonsLearnedNavigationItem[];

  @ApiProperty({ type: () => HomeNotificationsSummary })
  notifications!: HomeNotificationsSummary;

  @ApiProperty({ type: () => [HomeLessonSummary] })
  recentWork!: HomeLessonSummary[];

  @ApiProperty({ type: () => HomeHighlights })
  highlights!: HomeHighlights;

  @ApiProperty({ type: () => HomePrimaryAction })
  primaryAction!: HomePrimaryAction;

  @ApiProperty({ type: () => [HomeShortcut] })
  shortcuts!: HomeShortcut[];
}
