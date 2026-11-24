import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Matches, Min } from 'class-validator';
import { AllocationApprovalResponseDto } from '../approvals/approve-request.dto';
import {
  AllocationHoursByStateDto,
  AllocationPeriodDto,
  AllocationPersonSummaryDto,
  CursorPageInfoDto,
  allocationStateValues,
} from '../common/resource-allocation-contract.dto';
import { allocationCategories, type AllocationCategory } from './allocation-category';

export const allocationStates = allocationStateValues;
export class CreateAllocationDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Person to allocate. Omit it, or send the current person, for an own operational allocation; any other person makes a direct allocation that requires leadership scope over the person\'s group.',
  })
  @IsOptional()
  @IsUUID()
  personId?: string;

  @ApiProperty({
    enum: allocationCategories,
    description: 'Operational categories (ROUTINE_SUPPORT, TRAINING, INTERNAL_ACTIVITIES, VACATION) never use an initiative. Initiative categories require initiativeId and are available only to direct allocations.',
  })
  @IsIn(allocationCategories)
  category!: AllocationCategory;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Required except for VACATION, which never has a resource profile.' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'ITDM initiative; required for initiative categories and rejected for operational categories.' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string | null;

  @ApiProperty({ type: String, format: 'date', description: 'Inclusive start date in America/Sao_Paulo. Past dates are allowed.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @ApiProperty({ type: String, format: 'date', description: 'Inclusive end date in America/Sao_Paulo; on or after startDate.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate!: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0.01,
    maximum: 40,
    description: 'Required except for VACATION, which is always 40. Rounded half up to one decimal place; overlaps and totals above 40 are not blocked.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(40)
  weeklyHours?: number;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true, description: 'Required for ROUTINE_SUPPORT, TRAINING, and INTERNAL_ACTIVITIES.' })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}

export class AllocationGroupOptionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class AllocationGroupCollectionResponseDto {
  @ApiProperty({ type: () => [AllocationGroupOptionDto] })
  items!: AllocationGroupOptionDto[];
}

export class AllocationCollectionQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  personId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ type: String, enum: allocationStates })
  @IsOptional()
  @IsIn(allocationStates)
  operationalState?: typeof allocationStates[number];

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodStart?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodEnd?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}

export class AllocationLoadQueryDto {
  @ApiProperty({ type: String, format: 'date' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  personId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}

export class AllocationCommandDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(2000)
  @Matches(/\S/, { message: 'reason must contain at least one non-space character.' })
  reason!: string;
}

export class AllocationViewDto extends AllocationApprovalResponseDto {
  @ApiProperty({ type: () => AllocationPeriodDto })
  approvedPeriod!: AllocationPeriodDto;

  @ApiProperty({ enum: allocationStates })
  declare state: string;

  @ApiProperty({ enum: ['SUSPEND', 'RESERVE', 'RESUME', 'ACTIVATE', 'COMPLETE', 'CANCEL'], isArray: true })
  availableActions!: string[];
}

export class AllocationCollectionResponseDto {
  @ApiProperty({ type: () => AllocationViewDto, isArray: true })
  items!: AllocationViewDto[];

  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}

export class AllocationLoadItemDto {
  @ApiProperty({ type: () => AllocationPersonSummaryDto })
  person!: AllocationPersonSummaryDto;

  @ApiProperty({ type: () => AllocationHoursByStateDto, description: 'Weekly hours summed by current operational state.' })
  weeklyHoursByState!: AllocationHoursByStateDto;

  @ApiProperty({ type: Number })
  totalWeeklyHours!: number;
}

export class AllocationLoadResponseDto {
  @ApiProperty({ type: String, format: 'date' })
  date!: string;

  @ApiProperty({ type: () => AllocationLoadItemDto, isArray: true })
  items!: AllocationLoadItemDto[];

  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}

export class AllocationHistoryEventDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  actor!: Record<string, unknown>;

  @ApiProperty({ type: String })
  action!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: Object, additionalProperties: true })
  before!: Record<string, unknown>;

  @ApiProperty({ type: Object, additionalProperties: true })
  after!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;
}

export class AllocationHistoryCollectionResponseDto {
  @ApiProperty({ type: () => AllocationHistoryEventDto, isArray: true })
  items!: AllocationHistoryEventDto[];

  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}
