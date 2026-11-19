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

export const LESSON_LIBRARY_SORTS = ['newest', 'oldest', 'most-voted', 'title', 'project', 'type'] as const;
export type LessonsLibrarySort = typeof LESSON_LIBRARY_SORTS[number];

export class LessonsLibraryQuery extends LessonSearchFiltersQuery {
  @ApiPropertyOptional({
    enum: LESSON_LIBRARY_SORTS,
    default: 'newest',
    description: 'Sort the filtered published lessons before cursor pagination.',
  })
  @IsOptional()
  @IsIn(LESSON_LIBRARY_SORTS)
  sort?: LessonsLibrarySort;
}

export class PmoDraftsQuery extends LessonSubmissionsQuery {
  @ApiPropertyOptional({ type: String, description: 'Author profile ID.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  authorId?: string;
}

export const PMO_DASHBOARD_CARDS = [
  'awaiting-evaluation',
  'recently-approved',
  'recently-closed',
  'recently-returned',
] as const;
export type PmoDashboardCard = typeof PMO_DASHBOARD_CARDS[number];

export const PMO_DASHBOARD_SORTS = [
  'activity',
  'oldest-activity',
  'title',
  'status',
  'project',
  'type',
] as const;
export type PmoDashboardSort = typeof PMO_DASHBOARD_SORTS[number];

export class PmoDashboardQuery extends LessonSubmissionsQuery {
  @ApiPropertyOptional({
    enum: PMO_DASHBOARD_CARDS,
    description: 'Quick-filter slice matching one of the four operational summary cards.',
  })
  @IsOptional()
  @IsIn(PMO_DASHBOARD_CARDS)
  card?: PmoDashboardCard;

  @ApiPropertyOptional({
    enum: PMO_DASHBOARD_SORTS,
    default: 'activity',
    description: 'Sort order for the PMO Dashboard list.',
  })
  @IsOptional()
  @IsIn(PMO_DASHBOARD_SORTS)
  sort?: PmoDashboardSort;
}

export type LessonSearchFilters = Pick<
  LessonSearchFiltersQuery,
  'search' | 'projectId' | 'withoutProject' | 'lessonType'
>;

export type LessonSubmissionsFilter = LessonSearchFilters & Pick<LessonSubmissionsQuery, 'status'>;

export type PmoEvaluationQueueFilter = LessonSearchFilters;

export type LessonsLibraryFilter = LessonSearchFilters & Pick<LessonsLibraryQuery, 'sort'>;

export type PmoDraftsFilter = LessonSubmissionsFilter & Pick<PmoDraftsQuery, 'authorId'>;

export type PmoDashboardFilter = LessonSubmissionsFilter & Pick<PmoDashboardQuery, 'card' | 'sort'>;
