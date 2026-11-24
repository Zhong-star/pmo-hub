import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ProtectedResourceProblems } from '../access/problem-response.decorator';
import { createValidationPipe, localProfileHeader } from '../access/resource-allocation-problem';
import {
  CapacityCollectionQueryDto,
  CapacityCollectionResponseDto,
  CapacityHistoryCollectionResponseDto,
  CapacityHistoryQueryDto,
  CapacityOptionsResponseDto,
  CapacityResponseDto,
  CreateCapacityRequestDto,
  RemoveCapacityRequestDto,
  UpdateCapacityRequestDto,
} from './capacity.dto';
import { ResourceCapacityService } from './resource-capacity.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

const collectionValidation = createValidationPipe(CapacityCollectionQueryDto);
const createValidation = createValidationPipe(CreateCapacityRequestDto);
const updateValidation = createValidationPipe(UpdateCapacityRequestDto);
const removeValidation = createValidationPipe(RemoveCapacityRequestDto);

@ApiTags('Tech Resource Allocation capacity')
@ApiSecurity('localProfile')
@ProtectedResourceProblems()
@Controller()
export class ResourceCapacityController {
  constructor(
    @Inject(ResourceCapacityService)
    private readonly capacityService: ResourceCapacityService,
  ) {}

  @Get('capacity-options')
  @ApiOperation({ summary: 'List active groups and resource profiles available for new capacity entries' })
  @ApiOkResponse({ type: CapacityOptionsResponseDto })
  @ApiForbiddenResponse({ description: 'Capacity planning is only available to leaders in scope and Admins.' })
  options(@Headers(localProfileHeader) localUserId: string | undefined) {
    return this.capacityService.getOptions(localUserId);
  }

  @Get('capacities')
  @ApiOperation({ summary: 'List capacity entries visible to the current leadership scope or Admin' })
  @ApiOkResponse({ type: CapacityCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'groupId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'resourceProfileId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'classification', required: false, enum: ['INTERNAL', 'THIRD_PARTY'] })
  @ApiBadRequestResponse({ description: 'A filter, limit, or cursor is invalid.' })
  @ApiForbiddenResponse({ description: 'The current profile is outside the requested capacity scope.' })
  list(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query(collectionValidation) query: CapacityCollectionQueryDto,
  ) {
    return this.capacityService.list(localUserId, query);
  }

  @Post('capacities')
  @ApiOperation({ summary: 'Create a dated FTE capacity entry' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: CapacityResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    ETag: { description: 'Omitted on a replayed receipt; fetch the resource for its current version.', schema: { type: 'string', example: '"1"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiBadRequestResponse({ description: 'The capacity value, date, justification, or required header is invalid.' })
  @ApiForbiddenResponse({ description: 'The current profile cannot maintain the requested group or effective date.' })
  @ApiResponse({ status: 409, description: 'Another capacity entry exists for this group, profile, classification, and date.' })
  @ApiUnprocessableEntityResponse({ description: 'The group or resource profile is not eligible.' })
  async create(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(createValidation) input: CreateCapacityRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result, replayed } = await this.capacityService.create(localUserId, idempotencyKey, input);
    response.setHeader('Location', `/api/resource-allocation/v1/capacities/${result.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Get('capacities/:id')
  @ApiOperation({ summary: 'Read a capacity entry' })
  @ApiOkResponse({ type: CapacityResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiNotFoundResponse({ description: 'The capacity entry was not found.' })
  @ApiForbiddenResponse({ description: 'The current profile is outside the capacity group scope.' })
  async get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const capacity = await this.capacityService.get(localUserId, id);
    response.setHeader('ETag', `"${capacity.version}"`);
    return capacity;
  }

  @Patch('capacities/:id')
  @ApiOperation({ summary: 'Update the FTE value or effective date of a capacity entry' })
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong ETag version from the latest capacity response.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: CapacityResponseDto, headers: {
    ETag: { schema: { type: 'string', example: '"2"' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, or merge patch is invalid.' })
  @ApiNotFoundResponse({ description: 'The capacity entry was not found.' })
  @ApiForbiddenResponse({ description: 'The current profile cannot change the original or resulting effective date.' })
  @ApiResponse({ status: 409, description: 'The requested effective date already has capacity for this group, profile, and classification.' })
  @ApiResponse({ status: 412, description: 'The capacity version changed.' })
  async update(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(updateValidation) input: UpdateCapacityRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result, replayed } = await this.capacityService.update(localUserId, id, ifMatch, idempotencyKey, input);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Delete('capacities/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a capacity entry while retaining its audit history' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong ETag version from the latest capacity response.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiNoContentResponse({ description: 'The capacity entry was removed.' })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, or justification is invalid.' })
  @ApiNotFoundResponse({ description: 'The capacity entry was not found.' })
  @ApiForbiddenResponse({ description: 'The current profile cannot remove a capacity entry for a past date or outside its group scope.' })
  @ApiResponse({ status: 412, description: 'The capacity version changed.' })
  async remove(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(removeValidation) input: RemoveCapacityRequestDto,
  ) {
    await this.capacityService.remove(localUserId, id, ifMatch, idempotencyKey, input);
  }

  @Get('capacities/:id/history')
  @ApiOperation({ summary: 'Read immutable capacity changes, including a removed entry' })
  @ApiOkResponse({ type: CapacityHistoryCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiNotFoundResponse({ description: 'The capacity entry was not found.' })
  @ApiForbiddenResponse({ description: 'The current profile is outside the capacity group scope.' })
  history(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(createValidationPipe(CapacityHistoryQueryDto)) query: CapacityHistoryQueryDto,
  ) {
    return this.capacityService.listHistory(localUserId, id, query);
  }
}
