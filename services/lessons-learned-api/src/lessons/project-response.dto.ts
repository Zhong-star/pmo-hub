import { ApiProperty } from '@nestjs/swagger';

export class LessonProjectResponse {
  @ApiProperty({ type: String, example: 'LOCAL-PROJECT-001' })
  id!: string;

  @ApiProperty({ type: String, example: 'Fictional Atlas Modernization' })
  name!: string;
}
