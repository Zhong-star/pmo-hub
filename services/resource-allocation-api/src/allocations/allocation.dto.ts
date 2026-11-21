import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Matches, Min } from 'class-validator';
import { AllocationApprovalResponseDto } from '../approvals/approve-request.dto';

export const allocationStates = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUSPENDED',
  'ALLOCATED_WITHOUT_ACTION',
  'DONE',
  'CANCELED',
] as const;

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

export class AllocationPageInfoDto {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: Number, minimum: 1, maximum: 100 })
  limit!: number;
}

export class AllocationViewDto extends AllocationApprovalResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;

  @ApiProperty({ type: Object, example: { startDate: '2027-01-05', endDate: '2027-01-19' } })
  approvedPeriod!: { startDate: string; endDate: string };

  @ApiProperty({ enum: allocationStates })
  declare state: string;

  @ApiProperty({ enum: ['SUSPEND', 'RESERVE', 'RESUME', 'ACTIVATE', 'COMPLETE', 'CANCEL'], isArray: true })
  availableActions!: string[];
}

export class AllocationCollectionResponseDto {
  @ApiProperty({ type: () => AllocationViewDto, isArray: true })
  items!: AllocationViewDto[];

  @ApiProperty({ type: () => AllocationPageInfoDto })
  page!: AllocationPageInfoDto;
}

export class AllocationLoadItemDto {
  @ApiProperty({ type: Object })
  person!: { personId: string; displayName: string };

  @ApiProperty({ type: Object, description: 'Weekly hours summed by current operational state.' })
  weeklyHoursByState!: Record<typeof allocationStates[number], number>;

  @ApiProperty({ type: Number })
  totalWeeklyHours!: number;
}

export class AllocationLoadResponseDto {
  @ApiProperty({ type: String, format: 'date' })
  date!: string;

  @ApiProperty({ type: () => AllocationLoadItemDto, isArray: true })
  items!: AllocationLoadItemDto[];

  @ApiProperty({ type: () => AllocationPageInfoDto })
  page!: AllocationPageInfoDto;
}

export class AllocationHistoryEventDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object })
  actor!: Record<string, unknown>;

  @ApiProperty({ type: String })
  action!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: Object })
  before!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  after!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;
}

export class AllocationHistoryCollectionResponseDto {
  @ApiProperty({ type: () => AllocationHistoryEventDto, isArray: true })
  items!: AllocationHistoryEventDto[];

  @ApiProperty({ type: () => AllocationPageInfoDto })
  page!: AllocationPageInfoDto;
}
