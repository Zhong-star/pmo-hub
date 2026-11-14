import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { lessonTypes } from './lesson-fields-request.dto';

export const lessonStatuses = ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'] as const;

export class LessonSubmissionsQuery {
  @ApiPropertyOptional({ type: String, description: 'A title prefix or an exact numeric lesson ID.' })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({ type: String, description: 'Project catalog ID, or "none" for lessons without a project.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  projectId?: string;

  @ApiPropertyOptional({ enum: lessonTypes })
  @IsOptional()
  @IsIn(lessonTypes)
  lessonType?: typeof lessonTypes[number];

  @ApiPropertyOptional({ enum: lessonStatuses })
  @IsOptional()
  @IsIn(lessonStatuses)
  status?: typeof lessonStatuses[number];
}

export type LessonSubmissionsFilter = Pick<LessonSubmissionsQuery, 'search' | 'projectId' | 'lessonType' | 'status'>;
