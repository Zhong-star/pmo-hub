import { ApiProperty } from '@nestjs/swagger';

export type LessonStatus = 'Open' | 'PMOEvaluation' | 'Approved' | 'Closed' | 'Archived';

export class LessonDraftResponse {
  @ApiProperty({ type: Number, example: 1 })
  id!: number;

  @ApiProperty({ type: String, maxLength: 150, example: 'Improve release handover' })
  title!: string;

  @ApiProperty({ type: String, example: 'local-contributor' })
  authorId!: string;

  @ApiProperty({ type: String, example: 'local-contributor' })
  updatedBy!: string;

  @ApiProperty({ type: String, enum: ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'], example: 'Open' })
  status!: LessonStatus;

  @ApiProperty({ type: Number, minimum: 1, example: 1 })
  version!: number;

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
    enum: ['Future Prevention', 'Success to Repeat', 'Risk Avoided', 'Communication'],
    nullable: true,
  })
  lessonType!: 'Future Prevention' | 'Success to Repeat' | 'Risk Avoided' | 'Communication' | null;

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
}

export class LessonHistoryEventResponse {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: String })
  actorId!: string;

  @ApiProperty({ type: String, enum: ['Created', 'Submitted', 'Cancelled'] })
  eventType!: 'Created' | 'Submitted' | 'Cancelled';

  @ApiProperty({ type: String, enum: ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'], nullable: true })
  previousStatus!: LessonStatus | null;

  @ApiProperty({ type: String, enum: ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'] })
  newStatus!: LessonStatus;

  @ApiProperty({ type: String, nullable: true, maxLength: 1000 })
  reason!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: Date;
}

export class LessonDetailsResponse extends LessonDraftResponse {
  @ApiProperty({ type: LessonHistoryEventResponse, isArray: true })
  history!: LessonHistoryEventResponse[];
}
