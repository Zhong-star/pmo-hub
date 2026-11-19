import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class CreateLessonCommentRequest {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 2000,
    example: 'We adopted this checklist on the last release and avoided two handover gaps.',
  })
  @IsString({ message: 'Enter a comment between 1 and 2,000 characters.' })
  @Matches(/\S/, { message: 'Enter a comment before posting.' })
  @MaxLength(2000, { message: 'Comments must be 2,000 characters or fewer.' })
  body!: string;
}
