import { ApiProperty } from '@nestjs/swagger';

export class LessonSubmissionValidationResponse {
  @ApiProperty({ example: 'INVALID_LESSON_SUBMISSION', type: String })
  code!: 'INVALID_LESSON_SUBMISSION';

  @ApiProperty({ example: 'Correct the indicated fields before submitting.', type: String })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  fieldErrors!: Record<string, string>;
}
