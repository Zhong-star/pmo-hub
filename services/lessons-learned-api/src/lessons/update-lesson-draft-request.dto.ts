import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { LessonDraftFieldsRequest } from './lesson-fields-request.dto';

export class UpdateLessonDraftRequest extends LessonDraftFieldsRequest {
  @ApiProperty({ type: Number, minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  version!: number;
}
