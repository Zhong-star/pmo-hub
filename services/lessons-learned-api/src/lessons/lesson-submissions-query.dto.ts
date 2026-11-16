import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LESSON_STATUSES, LESSON_TYPES, type LessonStatus, type LessonType } from './lesson-domain.constants';

export class LessonSearchFiltersQuery {
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

  @ApiPropertyOptional({ enum: LESSON_TYPES })
  @IsOptional()
  @IsIn(LESSON_TYPES)
  lessonType?: LessonType;

}

export class LessonSubmissionsQuery extends LessonSearchFiltersQuery {
  @ApiPropertyOptional({ enum: LESSON_STATUSES })
  @IsOptional()
  @IsIn(LESSON_STATUSES)
  status?: LessonStatus;
}

export class PmoEvaluationQueueQuery extends LessonSearchFiltersQuery {}

export class LessonsLibraryQuery extends LessonSearchFiltersQuery {}

export class PmoDraftsQuery extends LessonSubmissionsQuery {
  @ApiPropertyOptional({ type: String, description: 'Author profile ID.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  authorId?: string;
}

export type LessonSearchFilters = Pick<
  LessonSearchFiltersQuery,
  'search' | 'projectId' | 'withoutProject' | 'lessonType'
>;

export type LessonSubmissionsFilter = LessonSearchFilters & Pick<LessonSubmissionsQuery, 'status'>;

export type PmoEvaluationQueueFilter = LessonSearchFilters;

export type LessonsLibraryFilter = LessonSearchFilters;

export type PmoDraftsFilter = LessonSubmissionsFilter & Pick<PmoDraftsQuery, 'authorId'>;
