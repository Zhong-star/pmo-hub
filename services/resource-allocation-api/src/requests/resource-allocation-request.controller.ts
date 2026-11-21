import {
  Body,
  Controller,
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
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { localProfileHeader } from '../access/resource-allocation-problem';
import { ResourceAllocationRequestService } from './resource-allocation-request.service';
import {
  RequestCollectionQueryDto,
  ResourceRequestAuditCollectionResponseDto,
  ResourceRequestAuditEventResponseDto,
  ResourceRequestAuditResponseDto,
  ResourceRequestCollectionResponseDto,
  ResourceRequestResponseDto,
  UpdateRequestedConditionsDto,
  WithdrawResourceRequestDto,
} from './request.dto';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

function validatedBody(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

@ApiTags('Tech Resource Allocation requests')
@Controller('requests')
export class ResourceAllocationRequestController {
  constructor(
    @Inject(ResourceAllocationRequestService)
    private readonly requestService: ResourceAllocationRequestService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the current requester’s operational requests or requests visible to current leadership scope' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceRequestCollectionResponseDto })
  @ApiQuery({ name: 'initiativeId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'decisionState', required: false, enum: ['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION', 'APPROVED_WITH_CHANGES', 'APPROVED', 'DENIED', 'PRE_N3', 'ESCALATION', 'REQUIRES_REVALIDATION', 'CANCELLED'] })
  @ApiQuery({ name: 'groupId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'resourceProfileId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'scope', required: false, enum: ['visible'], description: 'Opt into requests visible to the current leadership scope or Admin global scope. Defaults to own requests.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiBadRequestResponse({ description: 'A filter, limit, or cursor is invalid.' })
  list(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) query: RequestCollectionQueryDto,
  ) {
    return this.requestService.list(localUserId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read an operational request owned by the caller or visible to their current leadership/Admin scope' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceRequestResponseDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The request is not operational or is outside the caller’s current read scope.' })
  async get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { request: item, allocation, dueAt, availableActions, revalidation } = await this.requestService.get(localUserId, id);
    response.setHeader('ETag', `"${item.version}"`);
    return {
      id: item.id,
      requesterSnapshot: item.requesterSnapshot,
      requestedConditions: item.requestedConditions,
      approvedConditions: item.approvedConditions,
      allocation,
      decisionState: item.decisionState,
      receivedAt: item.receivedAt.toISOString(),
      stageEnteredAt: item.stageEnteredAt.toISOString(),
      expirationDueAt: item.expirationDueAt.toISOString(),
      dueAt,
      availableActions,
      revalidation,
      version: item.version,
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit requested conditions while waiting for presentation' })
  @ApiSecurity('localProfile')
  @ApiConsumes('application/merge-patch+json')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong ETag version from the latest request response.' })
  @ApiOkResponse({ type: ResourceRequestResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } } } })
  @ApiBadRequestResponse({ description: 'If-Match or requested conditions are invalid.' })
  @ApiForbiddenResponse({ description: 'The current profile is not active.' })
  @ApiNotFoundResponse({ description: 'The request is not operational or does not belong to this requester.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is no longer waiting or selected references/dates are ineligible.' })
  async update(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validatedBody(UpdateRequestedConditionsDto)) input: UpdateRequestedConditionsDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const item = await this.requestService.update(localUserId, id, ifMatch, correlationId, input);
    response.setHeader('ETag', `"${item.version}"`);
    return {
      id: item.id,
      requesterSnapshot: item.requesterSnapshot,
      requestedConditions: item.requestedConditions,
      decisionState: item.decisionState,
      receivedAt: item.receivedAt.toISOString(),
      stageEnteredAt: item.stageEnteredAt.toISOString(),
      expirationDueAt: item.expirationDueAt.toISOString(),
      version: item.version,
    };
  }

  @Post(':id/withdrawals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a request while it is waiting for presentation' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID identifying this withdrawal command.' })
  @ApiOkResponse({ type: ResourceRequestAuditEventResponseDto, headers: { 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, or reason is invalid.' })
  @ApiForbiddenResponse({ description: 'The current profile is not active.' })
  @ApiNotFoundResponse({ description: 'The request is not operational or does not belong to this requester.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused for different content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is no longer waiting for presentation.' })
  async withdraw(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validatedBody(WithdrawResourceRequestDto)) input: WithdrawResourceRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result, replayed } = await this.requestService.withdraw(localUserId, id, ifMatch, idempotencyKey, correlationId, input.reason);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result;
  }
}

@ApiTags('Tech Resource Allocation request audits')
@ApiSecurity('localProfile')
@Controller('request-audits')
export class ResourceAllocationRequestAuditController {
  constructor(
    @Inject(ResourceAllocationRequestService)
    private readonly requestService: ResourceAllocationRequestService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Read audit history for a removed request' })
  @ApiOkResponse({ type: ResourceRequestAuditResponseDto })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The audit does not exist or the current profile is not allowed to read it.' })
  get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.requestService.getAudit(localUserId, id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'List immutable events for a removed request audit' })
  @ApiOkResponse({ type: ResourceRequestAuditCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The audit does not exist or the current profile is not allowed to read it.' })
  listEvents(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.requestService.listAuditEvents(localUserId, id, { limit, cursor });
  }
}
