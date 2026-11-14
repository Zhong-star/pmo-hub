import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Matches, MaxLength, Min } from 'class-validator';

export class RejectLessonRequest {
  @ApiProperty({ type: Number, minimum: 1, example: 2 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, example: 'This lesson duplicates existing guidance.' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}
