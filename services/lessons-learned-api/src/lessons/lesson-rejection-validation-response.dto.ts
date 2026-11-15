import { ApiProperty } from '@nestjs/swagger';

export class LessonRejectionValidationResponse {
  @ApiProperty({ example: 'INVALID_LESSON_REJECTION', type: String })
  code!: 'INVALID_LESSON_REJECTION';

  @ApiProperty({ example: 'Enter a valid rejection reason.', type: String })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  fieldErrors!: Record<string, string>;
}
