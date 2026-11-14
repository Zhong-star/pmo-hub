import { ApiProperty } from '@nestjs/swagger';

export class LessonEditValidationResponse {
  @ApiProperty({ example: 'INVALID_LESSON_EDIT', type: String })
  code!: 'INVALID_LESSON_EDIT';

  @ApiProperty({ example: 'Correct the indicated fields before saving.', type: String })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  fieldErrors!: Record<string, string>;
}
