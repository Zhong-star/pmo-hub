import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, MaxLength, Min } from 'class-validator';

export class ReturnLessonRequest {
  @ApiProperty({ type: Number, minimum: 1, example: 3 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, example: 'Please add the missing project context.' })
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  guidance!: string;
}
