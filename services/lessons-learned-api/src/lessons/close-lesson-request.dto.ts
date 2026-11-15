import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class CloseLessonRequest {
  @ApiProperty({ type: Number, minimum: 1, example: 7 })
  @IsInt()
  @Min(1)
  version!: number;
}
