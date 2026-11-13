import { ApiProperty } from '@nestjs/swagger';

export class LessonsLearnedProfile {
  @ApiProperty({ type: String, example: 'local-contributor' })
  id!: string;

  @ApiProperty({ type: String, example: 'Local Contributor' })
  displayName!: string;

  @ApiProperty({ type: String, enum: ['LESSONS_USER', 'LESSONS_MODERATOR'], example: 'LESSONS_USER' })
  role!: 'LESSONS_USER' | 'LESSONS_MODERATOR';
}

export class LessonsLearnedNavigationItem {
  @ApiProperty({ type: String, example: 'home' })
  id!: 'home';

  @ApiProperty({ type: String, example: 'Home' })
  label!: 'Home';

  @ApiProperty({ type: Boolean, example: true })
  current!: true;
}

export class LessonsLearnedHomeResponse {
  @ApiProperty({ type: () => LessonsLearnedProfile })
  profile!: LessonsLearnedProfile;

  @ApiProperty({ type: () => [LessonsLearnedNavigationItem] })
  navigation!: LessonsLearnedNavigationItem[];
}
