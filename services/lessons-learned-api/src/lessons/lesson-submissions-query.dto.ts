import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { lessonTypes } from './lesson-fields-request.dto';

export const lessonStatuses = ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'] as const;

export class LessonSubmissionsQuery {
  @ApiPropertyOptional({ type: String, description: 'A title prefix or an exact numeric lesson ID.' })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({ type: String, description: 'Project snapshot ID.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  projectId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Filter to lessons without a project.' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  withoutProject?: boolean;

  @ApiPropertyOptional({ enum: lessonTypes })
  @IsOptional()
  @IsIn(lessonTypes)
  lessonType?: typeof lessonTypes[number];

  @ApiPropertyOptional({ enum: lessonStatuses })
  @IsOptional()
  @IsIn(lessonStatuses)
  status?: typeof lessonStatuses[number];
}

export type LessonSubmissionsFilter = Pick<
  LessonSubmissionsQuery,
  'search' | 'projectId' | 'withoutProject' | 'lessonType' | 'status'
>;
