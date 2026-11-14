import { ApiProperty } from '@nestjs/swagger';

export const lessonConflictCodes = [
  'STALE_LESSON_VERSION',
  'LESSON_NOT_OPEN',
  'LESSON_NOT_AWAITING_EVALUATION',
  'LESSON_NOT_IN_EVALUATION',
] as const;

export class LessonConflictResponse {
  @ApiProperty({ enum: lessonConflictCodes, type: String })
  code!: (typeof lessonConflictCodes)[number];

  @ApiProperty({
    example: 'This draft changed after you opened it. Reload the current version before saving again.',
    type: String,
  })
  message!: string;
}
