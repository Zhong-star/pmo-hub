import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ApproveLessonRequest {
  @ApiPropertyOptional({ type: Number, minimum: 1, example: 4 })
  @IsInt()
  @Min(1)
  version!: number;
}
