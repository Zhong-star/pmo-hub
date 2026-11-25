import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CursorPageInfoDto } from '../common/resource-allocation-contract.dto';

export enum CapacityClassification {
  Internal = 'INTERNAL',
  ThirdParty = 'THIRD_PARTY',
}

export class CapacityCollectionQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: String, maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ enum: CapacityClassification })
  @IsOptional()
  @IsEnum(CapacityClassification)
  classification?: CapacityClassification;
}

export class CreateCapacityRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  groupId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  resourceProfileId!: string;

  @ApiProperty({ enum: CapacityClassification })
  @IsEnum(CapacityClassification)
  classification!: CapacityClassification;

  @ApiProperty({ type: String, format: 'date' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveDate!: string;

  @ApiProperty({ type: Number, minimum: 0, description: 'FTE value; excess precision is rounded to one decimal place. No upper bound.' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  fte!: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/)
  reason!: string;
}

export class UpdateCapacityRequestDto {
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveDate?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, description: 'FTE value; excess precision is rounded to one decimal place. No upper bound.' })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  fte?: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/)
  reason!: string;
}

export class RemoveCapacityRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/)
  reason!: string;
}

export class CapacityGroupDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
}

export class CapacityProfileDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Boolean }) active!: boolean;
}

export class CapacityResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: () => CapacityGroupDto }) group!: CapacityGroupDto;
  @ApiProperty({ type: () => CapacityProfileDto }) resourceProfile!: CapacityProfileDto;
  @ApiProperty({ enum: CapacityClassification }) classification!: CapacityClassification;
  @ApiProperty({ type: String, format: 'date' }) effectiveDate!: string;
  @ApiProperty({ type: Number, minimum: 0 }) fte!: number;
  @ApiProperty({ type: Number, minimum: 1 }) version!: number;
}

export class CapacityListItemDto extends CapacityResponseDto {
  @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Last inclusive day of this value: the day before the next entry for the same group, profile, and classification; null when no later entry exists.' })
  effectiveUntil!: string | null;
}

export class CapacityCollectionResponseDto {
  @ApiProperty({ type: () => CapacityListItemDto, isArray: true, description: 'Ordered by group, resource profile, classification, effective date, then id.' }) items!: CapacityListItemDto[];
  @ApiProperty({ type: () => CursorPageInfoDto }) page!: CursorPageInfoDto;
}

export class CapacityOptionsGroupDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: () => CapacityProfileDto, isArray: true }) resourceProfiles!: CapacityProfileDto[];
}

export class CapacityOptionsResponseDto {
  @ApiProperty({ type: () => CapacityOptionsGroupDto, isArray: true }) groups!: CapacityOptionsGroupDto[];
}

export class CapacityHistoryQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: String, maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}

export class CapacityHistoryActorDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) displayName!: string;
}

export class CapacityHistoryEventDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'REMOVED'] }) action!: string;
  @ApiProperty({ type: () => CapacityHistoryActorDto }) actor!: CapacityHistoryActorDto;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ type: () => CapacityResponseDto, nullable: true }) before!: CapacityResponseDto | null;
  @ApiProperty({ type: () => CapacityResponseDto, nullable: true }) after!: CapacityResponseDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
}

export class CapacityHistoryCollectionResponseDto {
  @ApiProperty({ type: () => CapacityHistoryEventDto, isArray: true }) items!: CapacityHistoryEventDto[];
  @ApiProperty({ type: () => CursorPageInfoDto }) page!: CursorPageInfoDto;
}

export class CapacityComparisonQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date', description: 'Monday of the first week (America/Sao_Paulo). Defaults to the current week.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  weekStart?: string;

  @ApiPropertyOptional({ type: String, format: 'date', description: 'Monday of the last week, inclusive; at most 26 weeks after weekStart. Defaults to weekStart.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  weekEnd?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ enum: CapacityClassification, description: 'Limits capacity, load, and totals to one classification; Unclassified load and vacation are then omitted.' })
  @IsOptional()
  @IsEnum(CapacityClassification)
  classification?: CapacityClassification;
}

export class CapacityComparisonFiguresDto {
  @ApiProperty({ type: Number, description: 'Planned work hours (Not Started, In Progress, Allocated without action, Done) in the week; full precision.' }) plannedHours!: number;
  @ApiProperty({ type: Number, description: 'Hours of suspended allocations, shown apart from planned work.' }) suspendedHours!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Known capacity hours (FTE × 8 per weekday with an entry); null when not configured for any weekday.' }) capacityHours!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'capacityHours / 40.' }) capacityFte!: number | null;
  @ApiProperty({ type: Boolean, description: 'Every weekday of every component has capacity and no Unclassified load is included.' }) complete!: boolean;
  @ApiProperty({ type: Number, nullable: true, description: 'plannedHours / capacityHours × 100 when complete and capacity is above zero; may exceed 100.' }) utilizationPercent!: number | null;
}

export class CapacityComparisonClassificationDto extends CapacityComparisonFiguresDto {
  @ApiProperty({ enum: CapacityClassification, nullable: true, description: 'Null for Unclassified load, which never has capacity.' })
  classification!: CapacityClassification | null;
}

export class CapacityComparisonProfileDto {
  @ApiProperty({ type: () => CapacityProfileDto }) resourceProfile!: CapacityProfileDto;
  @ApiProperty({ type: () => CapacityComparisonClassificationDto, isArray: true }) classifications!: CapacityComparisonClassificationDto[];
  @ApiProperty({ type: () => CapacityComparisonFiguresDto }) total!: CapacityComparisonFiguresDto;
}

export class CapacityComparisonGroupDto {
  @ApiProperty({ type: () => CapacityGroupDto }) group!: CapacityGroupDto;
  @ApiProperty({ type: () => CapacityComparisonProfileDto, isArray: true }) profiles!: CapacityComparisonProfileDto[];
  @ApiProperty({ type: Number, description: 'Planned hours from allocations recorded without a classification.' }) unclassifiedHours!: number;
  @ApiProperty({ type: Number, description: 'Vacation hours in the week, outside the work numerator and not deducted from capacity.' }) vacationHours!: number;
  @ApiProperty({ type: () => CapacityComparisonFiguresDto }) total!: CapacityComparisonFiguresDto;
}

export class CapacityComparisonWeekDto {
  @ApiProperty({ type: String, format: 'date' }) weekStart!: string;
  @ApiProperty({ type: String, format: 'date' }) weekEnd!: string;
  @ApiProperty({ type: () => CapacityComparisonGroupDto, isArray: true }) groups!: CapacityComparisonGroupDto[];
  @ApiProperty({ type: () => CapacityComparisonFiguresDto, description: 'All authorized groups in the filter, summed before dividing.' }) total!: CapacityComparisonFiguresDto;
}

export class CapacityComparisonResponseDto {
  @ApiProperty({ type: String, format: 'date', description: 'Current business date in America/Sao_Paulo.' }) businessDate!: string;
  @ApiProperty({ type: Boolean, description: 'False when a profile or classification filter is applied: Vacation has neither, so vacation hours are not reported.' }) vacationIncluded!: boolean;
  @ApiProperty({ type: () => CapacityComparisonWeekDto, isArray: true }) weeks!: CapacityComparisonWeekDto[];
}
