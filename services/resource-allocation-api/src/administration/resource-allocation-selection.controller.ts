import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ProblemResponse, ProtectedResourceProblems } from '../access/problem-response.decorator';
import { localProfileHeader } from '../access/resource-allocation-problem';
import { ResourceAllocationAdministrationService } from './resource-allocation-administration.service';
import {
  ResourceGroupSelectionCollectionDto,
  ResourceInitiativeSelectionCollectionDto,
  ResourcePersonSelectionCollectionDto,
  ResourceProfileSelectionCollectionDto,
} from './resource-administration.dto';

interface SelectionFilters {
  limit?: string;
  cursor?: string;
  groupId?: string;
}

@ApiTags('Tech Resource Allocation selections')
@ProtectedResourceProblems()
@Controller()
export class ResourceAllocationSelectionController {
  constructor(
    @Inject(ResourceAllocationAdministrationService)
    private readonly administrationService: ResourceAllocationAdministrationService,
  ) {}

  @Get('people')
  @ApiOperation({ summary: 'List minimum person-selection data for an active module user' })
  @ApiSecurity('localProfile')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'groupId', required: false, type: String, format: 'uuid' })
  @ApiOkResponse({ type: ResourcePersonSelectionCollectionDto, description: 'Active people with display name and group only.' })
  @ProblemResponse(400, 'A filter, limit, or cursor is invalid.')
  listPeople(@Headers(localProfileHeader) localUserId: string | undefined, @Query() filters: SelectionFilters) {
    return this.administrationService.listSelectablePeople(localUserId, filters);
  }

  @Get('groups')
  @ApiOperation({ summary: 'List active group-selection data for an active module user' })
  @ApiSecurity('localProfile')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: ResourceGroupSelectionCollectionDto, description: 'Active groups with their identifier and name only.' })
  @ProblemResponse(400, 'The limit or cursor is invalid.')
  listGroups(@Headers(localProfileHeader) localUserId: string | undefined, @Query() filters: SelectionFilters) {
    return this.administrationService.listSelectableGroups(localUserId, filters);
  }

  @Get('resource-profiles')
  @ApiOperation({ summary: 'List active resource-profile selection data for an active module user' })
  @ApiSecurity('localProfile')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'groupId', required: false, type: String, format: 'uuid' })
  @ApiOkResponse({ type: ResourceProfileSelectionCollectionDto, description: 'Active profiles in active groups with name and group identifier only.' })
  @ProblemResponse(400, 'A filter, limit, or cursor is invalid.')
  listResourceProfiles(@Headers(localProfileHeader) localUserId: string | undefined, @Query() filters: SelectionFilters) {
    return this.administrationService.listSelectableResourceProfiles(localUserId, filters);
  }

  @Get('initiatives')
  @ApiOperation({ summary: 'List active ITDM-selection data for an active module user' })
  @ApiSecurity('localProfile')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: ResourceInitiativeSelectionCollectionDto, description: 'Active ITDMs with their identifier, code and name only.' })
  @ProblemResponse(400, 'The limit or cursor is invalid.')
  listInitiatives(@Headers(localProfileHeader) localUserId: string | undefined, @Query() filters: SelectionFilters) {
    return this.administrationService.listSelectableInitiatives(localUserId, filters);
  }
}
