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
  @Type(() => Number)
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
  @Type(() => Number)
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

export class CapacityCollectionResponseDto {
  @ApiProperty({ type: () => CapacityResponseDto, isArray: true }) items!: CapacityResponseDto[];
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
