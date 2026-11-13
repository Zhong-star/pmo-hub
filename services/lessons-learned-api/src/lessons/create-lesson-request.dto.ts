import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateLessonRequest {
  @ApiProperty({ type: String, maxLength: 150, example: 'Improve release handover' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(150)
  title!: string;
}
