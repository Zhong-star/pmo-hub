import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ApproveRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  personId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Defaults to the requested profile. Choose a different profile only to correct it.' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000, description: 'Required when the approved profile differs from the requested profile.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  explanation?: string;
}

export class AllocationApprovalResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object })
  person!: { personId: string; displayName: string };

  @ApiProperty({ type: Object })
  group!: { id: string; name: string };

  @ApiProperty({ type: Object })
  initiative!: { id: string; code: string; name: string };

  @ApiProperty({ type: Object })
  resourceProfile!: { id: string; name: string };

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;

  @ApiProperty({ type: Number })
  weeklyHours!: number;

  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PROGRESS'] })
  state!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  approvedAt!: string;

  @ApiProperty({ type: Number })
  version!: number;
}

export class ApproveRequestResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Object })
  requester!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  requestedConditions!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  approvedConditions!: Record<string, unknown>;

  @ApiProperty({ type: () => AllocationApprovalResponseDto })
  allocation!: AllocationApprovalResponseDto;

  @ApiProperty({ enum: ['APPROVED'] })
  decisionState!: 'APPROVED';

  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  stageEnteredAt!: string;

  @ApiProperty({ type: Number })
  version!: number;
}

export class ApprovalCandidateQueryDto {
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

export class ApprovalCandidateDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  groupId!: string;
}

export class ApprovalCandidateCollectionDto {
  @ApiProperty({ type: () => ApprovalCandidateDto, isArray: true })
  items!: ApprovalCandidateDto[];

  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } })
  page!: { nextCursor: string | null; limit: number };
}
