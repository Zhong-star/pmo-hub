import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { ResourceRequestCategory, ResourceRequestDecisionState } from '../submissions/submission-category';

export const allocationStateValues = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUSPENDED',
  'ALLOCATED_WITHOUT_ACTION',
  'DONE',
  'CANCELED',
] as const;

export class CursorPageInfoDto {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: Number, minimum: 1, maximum: 100 })
  limit!: number;
}

export class ResourcePersonSnapshotDto {
  @ApiProperty({ type: String, format: 'uuid' })
  personId!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String })
  role!: string;
}

export class ResourceRequestConditionsDto {
  @ApiProperty({ type: String, format: 'uuid' })
  initiativeId!: string;

  @ApiProperty({ type: String })
  initiativeCode!: string;

  @ApiProperty({ type: String })
  initiativeName!: string;

  @ApiProperty({ enum: ResourceRequestCategory })
  category!: ResourceRequestCategory;

  @ApiProperty({ type: String, format: 'uuid' })
  groupId!: string;

  @ApiProperty({ type: String })
  groupName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  resourceProfileId!: string;

  @ApiProperty({ type: String })
  resourceProfileName!: string;

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;

  @ApiProperty({ type: Number })
  weeklyHours!: number;

  @ApiPropertyOptional({ type: String })
  comment?: string;
}

export class ApprovedRequestConditionsDto {
  @ApiProperty({ type: String, format: 'uuid' })
  personId!: string;

  @ApiProperty({ type: String })
  personName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  resourceProfileId!: string;

  @ApiProperty({ type: String })
  resourceProfileName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  groupId!: string;

  @ApiProperty({ type: String })
  groupName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  initiativeId!: string;

  @ApiProperty({ type: String })
  initiativeCode!: string;

  @ApiProperty({ type: String })
  initiativeName!: string;

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;

  @ApiProperty({ type: Number })
  weeklyHours!: number;

  @ApiPropertyOptional({ type: String })
  explanation?: string;
}

export class AllocationPersonSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  personId!: string;

  @ApiProperty({ type: String })
  displayName!: string;
}

export class AllocationGroupSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class AllocationInitiativeSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class AllocationResourceProfileSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: Boolean })
  active!: boolean;
}

export class AllocationPeriodDto {
  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;
}

export class AllocationHoursByStateDto {
  @ApiProperty({ type: Number }) NOT_STARTED!: number;
  @ApiProperty({ type: Number }) IN_PROGRESS!: number;
  @ApiProperty({ type: Number }) SUSPENDED!: number;
  @ApiProperty({ type: Number }) ALLOCATED_WITHOUT_ACTION!: number;
  @ApiProperty({ type: Number }) DONE!: number;
  @ApiProperty({ type: Number }) CANCELED!: number;
}

export class RequestResponsibleRoleDto {
  @ApiProperty({ type: String })
  role!: string;
}

export class ResourceAllocationSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: () => AllocationPersonSummaryDto })
  person!: AllocationPersonSummaryDto;

  @ApiProperty({ type: () => AllocationGroupSummaryDto })
  group!: AllocationGroupSummaryDto;

  @ApiProperty({ type: () => AllocationInitiativeSummaryDto })
  initiative!: AllocationInitiativeSummaryDto;

  @ApiProperty({ type: () => AllocationResourceProfileSummaryDto })
  resourceProfile!: AllocationResourceProfileSummaryDto;

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;

  @ApiProperty({ type: Number })
  weeklyHours!: number;

  @ApiProperty({ enum: allocationStateValues })
  state!: typeof allocationStateValues[number];

  @ApiProperty({ type: String, format: 'date-time' })
  approvedAt!: string;

  @ApiProperty({ type: Number })
  version!: number;
}

export class SubmittedConditionsDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  initiativeId?: string;

  @ApiPropertyOptional({ enum: ResourceRequestCategory })
  category?: ResourceRequestCategory;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  attemptKey?: string;

  @ApiProperty({ type: String, format: 'uuid' })
  groupId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  resourceProfileId!: string;

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  endDate!: string;

  @ApiProperty({ type: Number })
  weeklyHours!: number;

  @ApiPropertyOptional({ type: String })
  comment?: string;
}

export class SubmissionLineProblemDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiPropertyOptional({ type: String })
  detail?: string;

  @ApiPropertyOptional({ type: String })
  title?: string;
}

export class SubmissionRequestOutcomeDto {
  @ApiPropertyOptional({ type: String })
  status?: string;

  @ApiPropertyOptional({ type: String })
  action?: string;

  @ApiPropertyOptional({ type: String })
  reason?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  removedAt?: string;

  @ApiPropertyOptional({ enum: ResourceRequestDecisionState })
  decisionState?: ResourceRequestDecisionState;

  @ApiPropertyOptional({ type: () => ResourceRequestConditionsDto })
  requestedConditions?: Partial<ResourceRequestConditionsDto>;
}

@ApiExtraModels(RequestResponsibleRoleDto, ResourcePersonSnapshotDto)
export class RequestRevalidationDto {
  @ApiProperty({ enum: [
    ResourceRequestDecisionState.WaitingForPresentation,
    ResourceRequestDecisionState.PendingTeamDecision,
    ResourceRequestDecisionState.ApprovedWithChanges,
  ] })
  originState!: typeof ResourceRequestDecisionState.WaitingForPresentation
    | typeof ResourceRequestDecisionState.PendingTeamDecision
    | typeof ResourceRequestDecisionState.ApprovedWithChanges;

  @ApiProperty({ type: [String] })
  impediments!: string[];

  @ApiProperty({
    type: Object,
    oneOf: [
      { $ref: getSchemaPath(RequestResponsibleRoleDto) },
      {
        type: 'array',
        items: { $ref: getSchemaPath(ResourcePersonSnapshotDto) },
      },
    ],
  })
  nextResponsible!: { role: string } | ResourcePersonSnapshotDto[];
}
