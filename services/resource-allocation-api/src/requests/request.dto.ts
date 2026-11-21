import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ResourceRequestCategory, ResourceRequestDecisionState } from '../submissions/submission-category';
import {
  ApprovedRequestConditionsDto,
  CursorPageInfoDto,
  RequestRevalidationDto,
  ResourceAllocationSummaryDto,
  ResourcePersonSnapshotDto,
  ResourceRequestConditionsDto,
} from '../common/resource-allocation-contract.dto';

export class RequestCollectionQueryDto {
  @ApiPropertyOptional({ enum: ['visible'], description: 'Read requests across the caller’s current group scope. Requires a leadership role or Admin; the default is the caller’s own requests.' })
  @IsOptional()
  @IsIn(['visible'])
  scope?: 'visible';

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string;

  @ApiPropertyOptional({ enum: ResourceRequestDecisionState })
  @IsOptional()
  @IsEnum(ResourceRequestDecisionState)
  decisionState?: ResourceRequestDecisionState;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class UpdateRequestedConditionsDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string;

  @ApiPropertyOptional({ enum: ResourceRequestCategory })
  @IsOptional()
  @IsEnum(ResourceRequestCategory)
  category?: ResourceRequestCategory;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  @ApiPropertyOptional({ minimum: 0.01, maximum: 40, description: 'Rounded by the server to one decimal place.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0.01)
  @Max(40)
  weeklyHours?: number;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class WithdrawResourceRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class ResourceRequestCollectionItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: () => ResourcePersonSnapshotDto }) requesterSnapshot!: ResourcePersonSnapshotDto;
  @ApiProperty({ type: () => ResourceRequestConditionsDto }) requestedConditions!: ResourceRequestConditionsDto;
  @ApiPropertyOptional({ type: () => ApprovedRequestConditionsDto, nullable: true }) approvedConditions!: ApprovedRequestConditionsDto | null;
  @ApiProperty({ enum: ResourceRequestDecisionState }) decisionState!: ResourceRequestDecisionState;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) stageEnteredAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expirationDueAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: '72-hour requester response deadline when a date or hours proposal is awaiting acceptance.' }) dueAt!: string | null;
  @ApiProperty({ type: [String], example: ['ACCEPT'] }) availableActions!: string[];
  @ApiProperty({ type: Number }) version!: number;
}

export class ResourceRequestResponseDto extends ResourceRequestCollectionItemDto {
  @ApiProperty({ type: () => ResourceAllocationSummaryDto, nullable: true }) allocation!: ResourceAllocationSummaryDto | null;
  @ApiPropertyOptional({ type: () => RequestRevalidationDto, nullable: true, description: 'Current eligibility blockers and responsible actor while the request requires revalidation.' })
  revalidation!: RequestRevalidationDto | null;
}

export class ResourceRequestCollectionResponseDto {
  @ApiProperty({ type: () => ResourceRequestCollectionItemDto, isArray: true }) items!: ResourceRequestCollectionItemDto[];
  @ApiProperty({ type: () => CursorPageInfoDto }) page!: CursorPageInfoDto;
}

export class ResourceRequestAuditEventResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) requestId!: string;
  @ApiProperty({ enum: ['WITHDRAWN', 'ADMIN_REMOVED', 'EXPIRED'] }) action!: string;
  @ApiProperty({ type: Object, additionalProperties: true }) requesterSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true }) actorSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true }) requestSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: String, maxLength: 2000 }) reason!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: String, format: 'uuid' }) correlationId!: string;
}

export class ResourceRequestAuditResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) requestId!: string;
  @ApiProperty({ type: () => ResourceRequestAuditEventResponseDto, isArray: true }) events!: ResourceRequestAuditEventResponseDto[];
}

export class ResourceRequestAuditCollectionResponseDto {
  @ApiProperty({ type: () => ResourceRequestAuditEventResponseDto, isArray: true }) items!: ResourceRequestAuditEventResponseDto[];
  @ApiProperty({ type: () => CursorPageInfoDto }) page!: CursorPageInfoDto;
}
