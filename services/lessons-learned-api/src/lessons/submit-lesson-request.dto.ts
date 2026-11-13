import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { lessonTypes, projectCategories, projectPhases } from './lesson-fields-request.dto';

export class SubmitLessonRequest {
  @ApiProperty({ type: Number, minimum: 1, example: 2 })
  @IsInt()
  @Min(1)
  version!: number;

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

  @ApiProperty({ enum: projectCategories, example: 'Technology' })
  @IsIn(projectCategories)
  projectCategory!: typeof projectCategories[number];

  @ApiProperty({ enum: projectPhases, example: 'Execution' })
  @IsIn(projectPhases)
  projectPhase!: typeof projectPhases[number];

  @ApiProperty({ type: String, maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(4000)
  situationObserved!: string;

  @ApiPropertyOptional({ type: String, maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rootCause?: string | null;

  @ApiProperty({ enum: lessonTypes, example: 'Future Prevention' })
  @IsIn(lessonTypes)
  lessonType!: typeof lessonTypes[number];

  @ApiProperty({ type: String, maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(4000)
  impact!: string;

  @ApiProperty({ type: String, maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(4000)
  recommendation!: string;

  @ApiProperty({ type: String, maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(4000)
  applicability!: string;
}
