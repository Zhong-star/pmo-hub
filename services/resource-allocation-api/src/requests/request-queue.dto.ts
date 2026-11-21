import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class RequestQueueItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object })
  requester!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  requestedConditions!: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object, nullable: true })
  approvedConditions!: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: String, nullable: true, enum: ['OUTSOURCE', 'WAIT_FOR_EMB_RESOURCE', 'DEPRIORITIZE_OTHER_DEMANDS'] })
  resolutionStrategy!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  resolutionReason!: string | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  affectedInitiativeIds!: string[];

  @ApiProperty({ type: String })
  decisionState!: string;

  @ApiPropertyOptional({ type: String, nullable: true, enum: ['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION', 'APPROVED_WITH_CHANGES'] })
  originState!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  stageEnteredAt!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  dueAt!: string | null;

  @ApiProperty({ type: [String], example: [] })
  impediments!: string[];

  @ApiProperty({
    type: Array,
    oneOf: [
      { type: 'object', properties: { role: { type: 'string' } } },
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            personId: { type: 'string', format: 'uuid' },
            displayName: { type: 'string' },
            role: { type: 'string' },
          },
        },
      },
    ],
  })
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

export class RequestChangeReceiptDto extends PickType(RequestQueueItemDto, [
  'id', 'requester', 'requestedConditions', 'decisionState', 'originState', 'receivedAt', 'stageEnteredAt', 'dueAt', 'version',
] as const) {}

// This class intentionally accepts no fields; the request still needs a runtime DTO for whitelist validation.
export class ReferRequestDto {}

export class CorrectRequestReferencesDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Eligible person to use as the corrected exception assignee.' })
  @IsOptional()
  @IsUUID()
  personId?: string;

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
