import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class RequestQueueItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object })
  requester!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  requestedConditions!: Record<string, unknown>;

  @ApiProperty({ type: String })
  decisionState!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  stageEnteredAt!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  dueAt!: string | null;

  @ApiProperty({ type: [String], example: [] })
  impediments!: string[];

  @ApiProperty({ type: Object })
  nextResponsible!: Record<string, unknown> | Array<Record<string, unknown>>;

  @ApiProperty({ type: [String], example: ['REFER', 'ADMINISTRATIVE_REMOVE'] })
  availableActions!: string[];

  @ApiProperty({ type: Number, minimum: 1 })
  version!: number;
}

export class RequestQueueCollectionDto {
  @ApiProperty({ type: () => RequestQueueItemDto, isArray: true })
  items!: RequestQueueItemDto[];

  @ApiProperty({ type: Object })
  page!: { nextCursor: string | null; limit: number };
}

// This class intentionally accepts no fields; the request still needs a runtime DTO for whitelist validation.
export class ReferRequestDto {}

export class CorrectRequestReferencesDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  initiativeId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class AdministrativeRequestRemovalDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class RemovedRequestReceiptDto {
  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;

  @ApiProperty({ enum: ['ADMIN_REMOVED'] })
  action!: 'ADMIN_REMOVED';

  @ApiProperty({ type: String, format: 'date-time' })
  removedAt!: string;
}
