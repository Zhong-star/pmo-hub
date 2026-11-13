import { ApiProperty } from '@nestjs/swagger';

export class LessonDraftResponse {
  @ApiProperty({ type: Number, example: 1 })
  id!: number;

  @ApiProperty({ type: String, maxLength: 150, example: 'Improve release handover' })
  title!: string;

  @ApiProperty({ type: String, example: 'local-contributor' })
  authorId!: string;

  @ApiProperty({ type: String, enum: ['Open'], example: 'Open' })
  status!: 'Open';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
