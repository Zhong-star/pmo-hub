import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LESSON_STATUSES, LESSON_TYPES, type LessonStatus, type LessonType } from './lesson-domain.constants';
import { LessonProjectResponse } from './project-response.dto';

export type { LessonStatus } from './lesson-domain.constants';

export class LessonDraftResponse {
  @ApiProperty({ type: Number, example: 1 })
  id!: number;

  @ApiProperty({ type: String, maxLength: 150, example: 'Improve release handover' })
  title!: string;

  @ApiProperty({ type: String, example: 'local-contributor' })
  authorId!: string;

  @ApiPropertyOptional({ type: String, description: 'Display name of the author when available.' })
  authorName?: string;

  @ApiProperty({ type: String, example: 'local-contributor' })
  updatedBy!: string;

  @ApiProperty({ type: String, enum: LESSON_STATUSES, example: 'Open' })
  status!: LessonStatus;

  @ApiProperty({ type: Number, minimum: 1, example: 1 })
  version!: number;

  @ApiPropertyOptional({ type: String, description: 'Opaque ETag for this lesson version.' })
  etag?: string;

  @ApiProperty({ type: String, nullable: true, maxLength: 128 })
  projectId!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 200 })
  projectName!: string | null;

  @ApiProperty({ type: String, enum: ['Technology', 'Business', 'Infrastructure', 'Data'], nullable: true })
  projectCategory!: 'Technology' | 'Business' | 'Infrastructure' | 'Data' | null;

  @ApiProperty({
    type: String,
    enum: ['Initiation', 'Planning', 'Execution', 'Closure', 'Not Applicable'],
    nullable: true,
  })
  projectPhase!: 'Initiation' | 'Planning' | 'Execution' | 'Closure' | 'Not Applicable' | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 4000 })
  situationObserved!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 4000 })
  rootCause!: string | null;

  @ApiProperty({
    type: String,
    enum: LESSON_TYPES,
    nullable: true,
  })
  lessonType!: LessonType | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 4000 })
  impact!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 4000 })
  recommendation!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 4000 })
  applicability!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: String, nullable: true, maxLength: 1000, description: 'Most recent PMO return guidance while the lesson is Open.' })
  latestReviewGuidance!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;
}

export class LessonHistoryEventResponse {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: String })
  actorId!: string;

  @ApiProperty({ type: String, enum: ['Created', 'Submitted', 'Cancelled', 'Returned', 'Approved', 'Rejected', 'Closed'] })
  eventType!: 'Created' | 'Submitted' | 'Cancelled' | 'Returned' | 'Approved' | 'Rejected' | 'Closed';

  @ApiProperty({ type: String, enum: LESSON_STATUSES, nullable: true })
  previousStatus!: LessonStatus | null;

  @ApiProperty({ type: String, enum: LESSON_STATUSES })
  newStatus!: LessonStatus;

  @ApiProperty({ type: String, nullable: true, maxLength: 1000 })
  reason!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: Date;
}

export class LessonDetailsResponse extends LessonDraftResponse {
  @ApiProperty({ type: LessonHistoryEventResponse, isArray: true })
  history!: LessonHistoryEventResponse[];

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  votesCount!: number;

  @ApiProperty({ type: Boolean, example: false })
  hasVoted!: boolean;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  commentCount!: number;
}

export class LessonLibraryResponse extends LessonDraftResponse {
  @ApiProperty({ type: String, description: 'Display name of the author.' })
  declare authorName: string;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  viewCount!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  votesCount!: number;

  @ApiProperty({ type: Boolean, example: false })
  hasVoted!: boolean;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  commentCount!: number;
}

export class RecordLessonLibraryViewResponse {
  @ApiProperty({ type: Number, minimum: 0, example: 1 })
  viewCount!: number;
}

export class LessonVoteResponse {
  @ApiProperty({ type: Number, example: 1 })
  lessonId!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 1 })
  votesCount!: number;

  @ApiProperty({ type: Boolean, example: true })
  hasVoted!: boolean;
}

export class PmoDashboardLessonResponse extends LessonLibraryResponse {
  @ApiProperty({ type: String, format: 'date-time', description: 'Most recent relevant activity timestamp (UTC).' })
  lastActivityAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Most recent closure history event timestamp (UTC).' })
  latestClosedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Most recent return history event timestamp (UTC).' })
  latestReturnedAt!: Date | null;
}

export class PmoDashboardSummaryResponse {
  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  awaitingEvaluation!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  recentlyApproved!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  recentlyClosed!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  recentlyReturned!: number;
}

export class PmoDashboardResponse {
  @ApiProperty({ type: Number, example: 30, description: 'Fixed calendar day window in UTC.' })
  windowDays!: number;

  @ApiProperty({ type: String, format: 'date-time', description: 'UTC start timestamp of the 30-day window.' })
  windowStartAt!: Date;

  @ApiProperty({ type: PmoDashboardSummaryResponse })
  summary!: PmoDashboardSummaryResponse;

  @ApiProperty({ type: PmoDashboardLessonResponse, isArray: true })
  items!: PmoDashboardLessonResponse[];

  @ApiProperty({ type: LessonProjectResponse, isArray: true })
  projects!: LessonProjectResponse[];
}

export class ProfileSummaryResponse {
  @ApiProperty({ type: String, example: 'local-contributor' })
  id!: string;

  @ApiProperty({ type: String, example: 'Local Contributor' })
  displayName!: string;

  @ApiProperty({ type: String, example: 'LC' })
  initials!: string;

  @ApiProperty({ type: String, enum: ['LESSONS_USER', 'LESSONS_MODERATOR'], example: 'LESSONS_USER' })
  role!: 'LESSONS_USER' | 'LESSONS_MODERATOR';

  @ApiProperty({ type: Number, minimum: 0, example: 2 })
  publishedLessonsCount!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 5 })
  votesReceivedCount!: number;

  @ApiProperty({ type: Number, minimum: 0, example: 12 })
  viewsReceivedCount!: number;
}

export class ContributorProfileResponse {
  @ApiProperty({ type: ProfileSummaryResponse })
  profile!: ProfileSummaryResponse;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, example: null, description: 'Contributor ranking position when applicable.' })
  rankingPosition!: number | null;

  @ApiProperty({ type: Boolean, example: false, description: 'Whether the viewer can see unpublished lessons authored by this user.' })
  includesPrivateLessons!: boolean;

  @ApiProperty({ type: LessonLibraryResponse, isArray: true })
  items!: LessonLibraryResponse[];

  @ApiProperty({ type: LessonProjectResponse, isArray: true })
  projects!: LessonProjectResponse[];
}
