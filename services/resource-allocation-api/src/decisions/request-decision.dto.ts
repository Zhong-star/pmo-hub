import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';
import {
  ApprovedRequestConditionsDto,
  CursorPageInfoDto,
  ResourceAllocationSummaryDto,
  ResourcePersonSnapshotDto,
  ResourceRequestConditionsDto,
} from '../common/resource-allocation-contract.dto';

export class DenyRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  explanation!: string;
}

export class ContestRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  explanation!: string;
}

export class CancelDeniedRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class RequestHistoryQueryDto {
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

export class RequestDecisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: () => ResourcePersonSnapshotDto }) requesterSnapshot!: ResourcePersonSnapshotDto;
  @ApiProperty({ type: () => ResourceRequestConditionsDto }) requestedConditions!: ResourceRequestConditionsDto;
  @ApiPropertyOptional({ type: () => ApprovedRequestConditionsDto, nullable: true }) approvedConditions?: ApprovedRequestConditionsDto | null;
  @ApiPropertyOptional({ type: () => ResourceAllocationSummaryDto, nullable: true }) allocation?: ResourceAllocationSummaryDto | null;
  @ApiPropertyOptional({ enum: ['OUTSOURCE', 'WAIT_FOR_EMB_RESOURCE', 'DEPRIORITIZE_OTHER_DEMANDS'] }) resolutionStrategy?: string;
  @ApiPropertyOptional({ type: [String], format: 'uuid' }) affectedInitiativeIds?: string[];
  @ApiProperty({ type: String }) decisionState!: string;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) stageEnteredAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expirationDueAt!: string;
  @ApiProperty({ type: Number }) version!: number;
}

export class RequestHistoryEventDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: Object, additionalProperties: true }) actorSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true }) before!: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true }) after!: Record<string, unknown>;
  @ApiProperty({ type: String, maxLength: 2000, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: String, format: 'uuid' }) correlationId!: string;
}

export class RequestHistoryCollectionDto {
  @ApiProperty({ type: () => RequestHistoryEventDto, isArray: true }) items!: RequestHistoryEventDto[];
  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
  @ApiPropertyOptional({ type: () => RequestHistoryEventDto, nullable: true, description: 'Most recent denial event, independent of the page cursor.' })
  latestDenial!: RequestHistoryEventDto | null;
  @ApiPropertyOptional({ type: () => RequestHistoryEventDto, nullable: true, description: 'Most recent contest or cancellation event, independent of the page cursor.' })
  latestResponse!: RequestHistoryEventDto | null;
}
