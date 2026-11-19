import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class HideLessonCommentRequest {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 1000,
    example: 'Contains confidential client details not permitted in the repository.',
  })
  @IsString({ message: 'Enter a moderation reason between 1 and 1,000 characters.' })
  @Matches(/\S/, { message: 'Enter a reason for hiding this comment.' })
  @MaxLength(1000, { message: 'Moderation reason must be 1,000 characters or fewer.' })
  reason!: string;
}
