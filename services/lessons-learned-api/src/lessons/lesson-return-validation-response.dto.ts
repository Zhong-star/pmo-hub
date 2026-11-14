import { ApiProperty } from '@nestjs/swagger';

export class LessonReturnValidationResponse {
  @ApiProperty({ example: 'INVALID_LESSON_RETURN', type: String })
  code!: 'INVALID_LESSON_RETURN';

  @ApiProperty({ example: 'Enter guidance for the author.', type: String })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  fieldErrors!: Record<string, string>;
}
