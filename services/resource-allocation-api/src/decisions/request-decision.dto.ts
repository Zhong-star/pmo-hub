import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';

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
  @ApiProperty({ type: Object }) requesterSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object }) requestedConditions!: Record<string, unknown>;
  @ApiProperty({ type: String }) decisionState!: string;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) stageEnteredAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expirationDueAt!: string;
  @ApiProperty({ type: Number }) version!: number;
}

export class RequestHistoryEventDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: Object }) actorSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object }) before!: Record<string, unknown>;
  @ApiProperty({ type: Object }) after!: Record<string, unknown>;
  @ApiProperty({ type: String, maxLength: 2000, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: String, format: 'uuid' }) correlationId!: string;
}

export class RequestHistoryCollectionDto {
  @ApiProperty({ type: () => RequestHistoryEventDto, isArray: true }) items!: RequestHistoryEventDto[];
  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } })
  page!: { nextCursor: string | null; limit: number };
  @ApiPropertyOptional({ type: () => RequestHistoryEventDto, nullable: true, description: 'Most recent denial event, independent of the page cursor.' })
  latestDenial!: RequestHistoryEventDto | null;
  @ApiPropertyOptional({ type: () => RequestHistoryEventDto, nullable: true, description: 'Most recent contest or cancellation event, independent of the page cursor.' })
  latestResponse!: RequestHistoryEventDto | null;
}
