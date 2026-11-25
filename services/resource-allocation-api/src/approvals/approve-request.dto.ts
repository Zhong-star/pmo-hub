import { allocationCategories } from '../allocations/allocation-category';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  AllocationGroupSummaryDto,
  AllocationInitiativeSummaryDto,
  AllocationPersonSummaryDto,
  AllocationResourceProfileSummaryDto,
  ApprovedRequestConditionsDto,
  CursorPageInfoDto,
  ResourcePersonSnapshotDto,
  ResourceRequestConditionsDto,
} from '../common/resource-allocation-contract.dto';

export class ApproveRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  personId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Defaults to the requested profile. Choose a different profile only to correct it.' })
  @IsOptional()
  @IsUUID()
  resourceProfileId?: string;

  @ApiPropertyOptional({ type: String, format: 'date', description: 'Proposed start date. An acceptance-pending proposal must start on or after its 72-hour deadline in the business calendar.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ type: String, format: 'date', description: 'Proposed inclusive end date.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0.01, maximum: 40, description: 'Proposed weekly hours, rounded to one decimal place.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(40)
  weeklyHours?: number;

  @ApiPropertyOptional({ type: String, maxLength: 2000, description: 'Required when proposed dates or weekly hours differ from the request, or when correcting the approved profile.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  explanation?: string;
}

// This command intentionally takes no additional conditions; it accepts the displayed proposal as-is.
export class AcceptRequestChangesDto {}

export class AllocationApprovalResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Null when the allocation was created without a request.' })
  requestId!: string | null;

  @ApiProperty({ enum: ['REQUEST', 'SELF', 'DIRECT'] })
  source!: 'REQUEST' | 'SELF' | 'DIRECT';

  @ApiProperty({ enum: allocationCategories, nullable: true, description: 'Initiative or operational category captured when the allocation was created. Null only for legacy allocations whose request has no category.' })
  category!: string | null;

  @ApiProperty({ enum: ['INTERNAL', 'THIRD_PARTY'], nullable: true, description: 'Classification captured at allocation creation. Null means Unclassified.' })
  classification!: 'INTERNAL' | 'THIRD_PARTY' | null;

  @ApiProperty({ type: String, nullable: true, description: 'Operational activity description recorded at creation.' })
  comment!: string | null;

  @ApiProperty({ type: () => AllocationPersonSummaryDto })
  person!: AllocationPersonSummaryDto;

  @ApiProperty({ type: () => AllocationGroupSummaryDto })
  group!: AllocationGroupSummaryDto;

  @ApiProperty({ type: () => AllocationInitiativeSummaryDto, nullable: true, description: 'Null for operational allocations without an initiative.' })
  initiative!: AllocationInitiativeSummaryDto | null;

  @ApiProperty({ type: () => AllocationResourceProfileSummaryDto, nullable: true, description: 'Null for Vacation, which never uses a resource profile.' })
  resourceProfile!: AllocationResourceProfileSummaryDto | null;

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

  @ApiProperty({ type: () => ResourcePersonSnapshotDto })
  requester!: ResourcePersonSnapshotDto;

  @ApiProperty({ type: () => ResourceRequestConditionsDto })
  requestedConditions!: ResourceRequestConditionsDto;

  @ApiProperty({ type: () => ApprovedRequestConditionsDto })
  approvedConditions!: ApprovedRequestConditionsDto;

  @ApiProperty({ type: () => AllocationApprovalResponseDto, nullable: true, description: 'Null while a changed proposal awaits requester acceptance.' })
  allocation!: AllocationApprovalResponseDto | null;

  @ApiProperty({ enum: ['APPROVED', 'APPROVED_WITH_CHANGES'] })
  decisionState!: 'APPROVED' | 'APPROVED_WITH_CHANGES';

  @ApiPropertyOptional({ enum: ['REQUESTER_ACCEPTANCE', 'SYSTEM_DEADLINE'], nullable: true, description: 'Identifies whether a proposal was confirmed explicitly by the requester or automatically at its deadline.' })
  confirmationSource?: 'REQUESTER_ACCEPTANCE' | 'SYSTEM_DEADLINE' | null;

  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  stageEnteredAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Acceptance deadline for a changed proposal.' })
  dueAt!: string | null;

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

  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}
