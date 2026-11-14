import { ApiProperty } from '@nestjs/swagger';

export class LessonCancellationValidationResponse {
  @ApiProperty({ example: 'INVALID_LESSON_CANCELLATION', type: String })
  code!: 'INVALID_LESSON_CANCELLATION';

  @ApiProperty({ example: 'Enter a cancellation reason.', type: String })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  fieldErrors!: Record<string, string>;
}
