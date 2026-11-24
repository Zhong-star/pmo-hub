import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ProtectedResourceProblems } from '../access/problem-response.decorator';
import { createValidationPipe, localProfileHeader } from '../access/resource-allocation-problem';
import { CreateInitiativeRequestDto, ResourceInitiativeCollectionResponseDto, ResourceInitiativeResponseDto, UpdateInitiativeRequestDto } from '../initiatives/initiative-request.dto';
import {
  CreateResourceGroupRequestDto,
  CreateResourceProfileRequestDto,
  CreateResourcePersonRequestDto,
  ResourceGroupCollectionResponseDto,
  ResourceGroupSelectionCollectionDto,
  ResourceGroupResponseDto,
  ResourcePersonCollectionResponseDto,
  ResourcePersonClassificationHistoryCollectionResponseDto,
  ResourcePersonResponseDto,
  ResourceProfileCollectionResponseDto,
  ResourceProfileResponseDto,
  UpdateResourceGroupRequestDto,
  UpdateResourcePersonRequestDto,
  UpdateResourceProfileRequestDto,
} from './resource-administration.dto';
import { ResourceAllocationAdministrationService } from './resource-allocation-administration.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

const validatedBody = createValidationPipe;

@ApiTags('Tech Resource Allocation administration')
@ProtectedResourceProblems()
@Controller('admin')
export class ResourceAllocationAdministrationController {
  constructor(
    @Inject(ResourceAllocationAdministrationService)
    private readonly administrationService: ResourceAllocationAdministrationService,
  ) {}

  @Get('initiatives')
  @ApiOperation({ summary: 'List administrative ITDM records' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceInitiativeCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  async listInitiatives(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('active') active?: string,
  ) {
    return this.administrationService.listInitiatives(localUserId, { limit, cursor, active });
  }

  @Get('people')
  @ApiOperation({ summary: 'List administrative people' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourcePersonCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  async listPeople(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('active') active?: string,
  ) {
    return this.administrationService.listPeople(localUserId, { limit, cursor, active });
  }

  @Get('people/:id/classification-history')
  @ApiOperation({ summary: 'List immutable classification changes for an administrative person' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({
    type: ResourcePersonClassificationHistoryCollectionResponseDto,
    examples: {
      paginated: {
        summary: 'A page with a continuation cursor',
        value: {
          items: [{
            id: '11111111-1111-4111-8111-111111111111',
            previousClassification: 'INTERNAL',
            nextClassification: 'THIRD_PARTY',
            actor: {
              personId: '22222222-2222-4222-8222-222222222222',
              displayName: 'Morgan Admin',
              role: 'ALLOCATION_ADMIN',
            },
            occurredAt: '2026-11-23T09:00:00.000Z',
          }],
          page: { nextCursor: 'opaque-cursor', limit: 1 },
        },
      },
    },
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiBadRequestResponse({ description: 'The page limit or cursor is invalid.' })
  @ApiForbiddenResponse({ description: 'Only an active Admin may view administrative records.' })
  @ApiNotFoundResponse({ description: 'The person was not found.' })
  async listPersonClassificationHistory(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.administrationService.listPersonClassificationHistory(localUserId, id, { limit, cursor });
  }

  @Post('people')
  @ApiOperation({ summary: 'Create a module person' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: ResourcePersonResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    ETag: { description: 'Omitted on a replayed receipt; fetch the resource for its current version.', schema: { type: 'string', example: '"1"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiResponse({ status: 409, description: 'The local profile already has a module person.' })
  @ApiResponse({ status: 422, description: 'The role or group reference is not eligible.' })
  async createPerson(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(validatedBody(CreateResourcePersonRequestDto)) input: CreateResourcePersonRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result: person, replayed } = await this.administrationService.createPerson(localUserId, idempotencyKey, input);
    response.setHeader('Location', `/api/resource-allocation/v1/admin/people/${person.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${person.version}"`);
    return person;
  }

  @Get('people/:id')
  @ApiOperation({ summary: 'Get an administrative person' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourcePersonResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The person was not found.' })
  async getPerson(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const person = await this.administrationService.getPerson(localUserId, id);
    response.setHeader('ETag', `"${person.version}"`);
    return person;
  }

  @Patch('people/:id')
  @ApiOperation({ summary: 'Update an administrative person' })
  @ApiSecurity('localProfile')
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ResourcePersonResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The person was not found.' })
  @ApiResponse({ status: 400, description: 'If-Match or merge patch is invalid.' })
  @ApiResponse({ status: 412, description: 'The person changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The last Admin or an assigned group responsible cannot be removed.' })
  async updatePerson(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(validatedBody(UpdateResourcePersonRequestDto)) input: UpdateResourcePersonRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const person = await this.administrationService.updatePerson(localUserId, id, ifMatch, input);
    response.setHeader('ETag', `"${person.version}"`);
    return person;
  }

  @Get('groups')
  @ApiOperation({ summary: 'List administrative groups' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceGroupCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  async listGroups(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('active') active?: string,
  ) {
    return this.administrationService.listGroups(localUserId, { limit, cursor, active });
  }

  @Post('groups')
  @ApiOperation({ summary: 'Create an administrative group' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: ResourceGroupResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    ETag: { description: 'Omitted on a replayed receipt; fetch the resource for its current version.', schema: { type: 'string', example: '"1"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiResponse({ status: 422, description: 'The group needs active Supervisor and Manager references.' })
  async createGroup(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(validatedBody(CreateResourceGroupRequestDto)) input: CreateResourceGroupRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result: group, replayed } = await this.administrationService.createGroup(localUserId, idempotencyKey, input);
    response.setHeader('Location', `/api/resource-allocation/v1/admin/groups/${group.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${group.version}"`);
    return group;
  }

  @Get('groups/:id')
  @ApiOperation({ summary: 'Get an administrative group' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceGroupResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The group was not found.' })
  async getGroup(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const group = await this.administrationService.getGroup(localUserId, id);
    response.setHeader('ETag', `"${group.version}"`);
    return group;
  }

  @Patch('groups/:id')
  @ApiOperation({ summary: 'Update an administrative group' })
  @ApiSecurity('localProfile')
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ResourceGroupResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The group was not found.' })
  @ApiResponse({ status: 400, description: 'If-Match or merge patch is invalid.' })
  @ApiResponse({ status: 412, description: 'The group changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The responsible assignment is invalid.' })
  async updateGroup(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(validatedBody(UpdateResourceGroupRequestDto)) input: UpdateResourceGroupRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const group = await this.administrationService.updateGroup(localUserId, id, ifMatch, input);
    response.setHeader('ETag', `"${group.version}"`);
    return group;
  }

  @Get('resource-profiles')
  @ApiOperation({ summary: 'List resource profiles in the current administrative or leadership scope' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceProfileCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiBadRequestResponse({ description: 'The page limit, cursor, or active filter is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Admin or an in-scope Moderator, Supervisor, or Manager is required.' })
  async listResourceProfiles(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('active') active?: string,
  ) {
    return this.administrationService.listResourceProfiles(localUserId, { limit, cursor, active });
  }

  @Get('resource-profile-groups')
  @ApiOperation({ summary: 'List groups where the current user can manage resource profiles' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceGroupSelectionCollectionDto, description: 'Only active groups in the current profile-management scope, with identifier and name.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiBadRequestResponse({ description: 'The page limit or cursor is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Admin or an in-scope Moderator, Supervisor, or Manager is required.' })
  async listManageableResourceProfileGroups(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.administrationService.listManageableResourceProfileGroups(localUserId, { limit, cursor });
  }

  @Post('resource-profiles')
  @ApiOperation({ summary: 'Create a resource profile in the current administrative or leadership scope' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: ResourceProfileResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    ETag: { description: 'Omitted on a replayed receipt; fetch the resource for its current version.', schema: { type: 'string', example: '"1"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiBadRequestResponse({ description: 'The Idempotency-Key is missing or invalid.' })
  @ApiForbiddenResponse({ description: 'An active Admin or an in-scope Moderator, Supervisor, or Manager is required.' })
  @ApiResponse({ status: 422, description: 'The profile must belong to an active group.' })
  async createResourceProfile(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(validatedBody(CreateResourceProfileRequestDto)) input: CreateResourceProfileRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result: profile, replayed } = await this.administrationService.createResourceProfile(localUserId, idempotencyKey, input);
    response.setHeader('Location', `/api/resource-allocation/v1/admin/resource-profiles/${profile.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${profile.version}"`);
    return profile;
  }

  @Get('resource-profiles/:id')
  @ApiOperation({ summary: 'Get a resource profile in the current administrative or leadership scope' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceProfileResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiForbiddenResponse({ description: 'An active Admin or an in-scope Moderator, Supervisor, or Manager is required.' })
  @ApiNotFoundResponse({ description: 'The resource profile was not found.' })
  async getResourceProfile(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const profile = await this.administrationService.getResourceProfile(localUserId, id);
    response.setHeader('ETag', `"${profile.version}"`);
    return profile;
  }

  @Patch('resource-profiles/:id')
  @ApiOperation({ summary: 'Update a resource profile in the current administrative or leadership scope' })
  @ApiSecurity('localProfile')
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ResourceProfileResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } } } })
  @ApiForbiddenResponse({ description: 'An active Admin or an in-scope Moderator, Supervisor, or Manager is required.' })
  @ApiNotFoundResponse({ description: 'The resource profile was not found.' })
  @ApiResponse({ status: 400, description: 'If-Match or merge patch is invalid.' })
  @ApiResponse({ status: 409, description: 'A profile referenced by an allocation cannot be moved to another group.' })
  @ApiResponse({ status: 412, description: 'The resource profile changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The profile must belong to an active group.' })
  async updateResourceProfile(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(validatedBody(UpdateResourceProfileRequestDto)) input: UpdateResourceProfileRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const profile = await this.administrationService.updateResourceProfile(localUserId, id, ifMatch, input);
    response.setHeader('ETag', `"${profile.version}"`);
    return profile;
  }

  @Post('initiatives')
  @ApiOperation({ summary: 'Create an administrative ITDM' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: ResourceInitiativeResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    ETag: { description: 'Omitted on a replayed receipt; fetch the resource for its current version.', schema: { type: 'string', example: '"1"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiResponse({ status: 409, description: 'Another ITDM uses this normalized code.' })
  async createInitiative(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(validatedBody(CreateInitiativeRequestDto)) input: CreateInitiativeRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result: initiative, replayed } = await this.administrationService.createInitiative(localUserId, idempotencyKey, input);
    response.setHeader('Location', `/api/resource-allocation/v1/admin/initiatives/${initiative.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${initiative.version}"`);
    return initiative;
  }

  @Get('initiatives/:id')
  @ApiOperation({ summary: 'Get an administrative ITDM' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceInitiativeResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The ITDM was not found.' })
  async getInitiative(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const initiative = await this.administrationService.getInitiative(localUserId, id);
    response.setHeader('ETag', `"${initiative.version}"`);
    return {
      id: initiative.id,
      code: initiative.code,
      name: initiative.name,
      active: initiative.active,
      version: initiative.version,
    };
  }

  @Patch('initiatives/:id')
  @ApiOperation({ summary: 'Update an administrative ITDM' })
  @ApiSecurity('localProfile')
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong ETag version from the latest item response.' })
  @ApiOkResponse({ type: ResourceInitiativeResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may manage administrative records.' })
  @ApiNotFoundResponse({ description: 'The ITDM was not found.' })
  @ApiResponse({ status: 400, description: 'If-Match or merge patch is invalid.' })
  @ApiResponse({ status: 412, description: 'The ITDM changed since it was read.' })
  @ApiResponse({ status: 422, description: 'A used ITDM code cannot be changed.' })
  async updateInitiative(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(validatedBody(UpdateInitiativeRequestDto)) input: UpdateInitiativeRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const initiative = await this.administrationService.updateInitiative(localUserId, id, ifMatch, input);
    response.setHeader('ETag', `"${initiative.version}"`);
    return initiative;
  }
}
