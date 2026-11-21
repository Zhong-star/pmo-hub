import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ResourceRequestCategory } from './submission-category';

export class CreateSubmissionLineRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  attemptKey!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  groupId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  resourceProfileId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2027-01-11' })
  @IsString()
  @Length(10, 10)
  startDate!: string;

  @ApiProperty({ type: String, format: 'date', example: '2027-01-29' })
  @IsString()
  @Length(10, 10)
  endDate!: string;

  @ApiProperty({ type: Number, example: 20 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  weeklyHours!: number;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class CreateResourceSubmissionRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  initiativeId!: string;

  @ApiProperty({ enum: ResourceRequestCategory })
  @IsEnum(ResourceRequestCategory)
  category!: ResourceRequestCategory;

  @ApiProperty({ type: () => CreateSubmissionLineRequestDto, isArray: true, minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSubmissionLineRequestDto)
  lines!: CreateSubmissionLineRequestDto[];
}

export class SubmissionCountsDto {
  @ApiProperty({ type: Number }) received!: number;
  @ApiProperty({ type: Number }) processing!: number;
  @ApiProperty({ type: Number }) succeeded!: number;
  @ApiProperty({ type: Number }) failed!: number;
}

export class ResourceSubmissionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: Number }) lineCount!: number;
  @ApiProperty({ type: () => SubmissionCountsDto }) counts!: SubmissionCountsDto;
}

export class ResourceSubmissionLineResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) attemptKey!: string;
  @ApiProperty({ type: Object }) submittedConditions!: Record<string, unknown>;
  @ApiProperty({ enum: ['RECEIVED', 'PROCESSING', 'SUCCEEDED', 'FAILED'] }) status!: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) requestId?: string;
  @ApiPropertyOptional({ type: Object }) problem?: { code: string; message: string };
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) completedAt?: string;
  @ApiPropertyOptional({ type: Object }) requestOutcome?: Record<string, unknown>;
}

export class ResourceSubmissionCollectionResponseDto {
  @ApiProperty({ type: () => ResourceSubmissionResponseDto, isArray: true }) items!: ResourceSubmissionResponseDto[];
  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } }) page!: { nextCursor: string | null; limit: number };
}

export class ResourceSubmissionLineCollectionResponseDto {
  @ApiProperty({ type: () => ResourceSubmissionLineResponseDto, isArray: true }) items!: ResourceSubmissionLineResponseDto[];
  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } }) page!: { nextCursor: string | null; limit: number };
}
