import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ResourceRequestCategory, ResourceRequestDecisionState } from '../submissions/submission-category';

export class RequestCollectionQueryDto {
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

export class ResourceRequestResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: Object }) requesterSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object }) requestedConditions!: Record<string, unknown>;
  @ApiPropertyOptional({ type: Object, nullable: true }) approvedConditions!: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) allocation!: Record<string, unknown> | null;
  @ApiProperty({ enum: ResourceRequestDecisionState }) decisionState!: ResourceRequestDecisionState;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) stageEnteredAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expirationDueAt!: string;
  @ApiProperty({ type: Number }) version!: number;
}

export class ResourceRequestCollectionResponseDto {
  @ApiProperty({ type: () => ResourceRequestResponseDto, isArray: true }) items!: ResourceRequestResponseDto[];
  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } }) page!: { nextCursor: string | null; limit: number };
}

export class ResourceRequestAuditEventResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['WITHDRAWN', 'ADMIN_REMOVED', 'EXPIRED'] }) action!: string;
  @ApiProperty({ type: Object }) requesterSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object }) actorSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object }) requestSnapshot!: Record<string, unknown>;
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
  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } }) page!: { nextCursor: string | null; limit: number };
}
