import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { LESSON_TYPES } from './lesson-domain.constants';

export const projectCategories = ['Technology', 'Business', 'Infrastructure', 'Data'] as const;
export const projectPhases = ['Initiation', 'Planning', 'Execution', 'Closure', 'Not Applicable'] as const;

export class LessonDraftFieldsRequest {
  @ApiProperty({ type: String, maxLength: 150, example: 'Improve release handover' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({ type: String, maxLength: 128, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  projectId?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectName?: string | null;

  @ApiPropertyOptional({ enum: projectCategories, nullable: true })
  @IsOptional()
  @IsIn(projectCategories)
  projectCategory?: typeof projectCategories[number] | null;

  @ApiPropertyOptional({ enum: projectPhases, nullable: true })
  @IsOptional()
  @IsIn(projectPhases)
  projectPhase?: typeof projectPhases[number] | null;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  situationObserved?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rootCause?: string | null;

  @ApiPropertyOptional({ enum: LESSON_TYPES, nullable: true })
  @IsOptional()
  @IsIn(LESSON_TYPES)
  lessonType?: typeof LESSON_TYPES[number] | null;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  impact?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  recommendation?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  applicability?: string | null;
}
