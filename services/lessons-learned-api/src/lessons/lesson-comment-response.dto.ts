import { ApiProperty } from '@nestjs/swagger';

export class LessonCommentModerationResponse {
  @ApiProperty({ type: String, format: 'date-time' })
  hiddenAt!: Date;

  @ApiProperty({ type: String, example: 'local-pmo' })
  hiddenByUserId!: string;

  @ApiProperty({ type: String, example: 'Local PMO' })
  hiddenByDisplayName!: string;

  @ApiProperty({ type: String, maxLength: 1000 })
  reason!: string;
}

export class LessonCommentItemResponse {
  @ApiProperty({ type: Number, example: 1 })
  id!: number;

  @ApiProperty({ type: Number, example: 42 })
  lessonId!: number;

  @ApiProperty({ type: Number, nullable: true, example: null })
  parentCommentId!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'local-contributor' })
  authorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Local Contributor' })
  authorDisplayName!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 2000 })
  body!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: Boolean, example: false })
  isHidden!: boolean;

  @ApiProperty({ type: LessonCommentModerationResponse, nullable: true })
  moderation!: LessonCommentModerationResponse | null;
}

export class LessonCommentThreadResponse extends LessonCommentItemResponse {
  @ApiProperty({ type: [LessonCommentItemResponse] })
  replies!: LessonCommentItemResponse[];
}

class LessonCommentPageInfo {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: Number, minimum: 1, maximum: 100 })
  limit!: number;
}

export class LessonCommentPageResponse {
  @ApiProperty({ type: [LessonCommentThreadResponse] })
  items!: LessonCommentThreadResponse[];

  @ApiProperty({ type: LessonCommentPageInfo })
  page!: LessonCommentPageInfo;

  @ApiProperty({ type: Number, minimum: 0, example: 0 })
  publicCommentCount!: number;
}
