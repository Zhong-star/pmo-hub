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
  Post,
  Query,
  Res,
  type Type,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { localProfileHeader } from '../access/resource-allocation-problem';
import {
  AdministrativeRequestRemovalDto,
  CorrectRequestReferencesDto,
  ReferRequestDto,
  RemovedRequestReceiptDto,
  RequestQueueCollectionDto,
} from './request-queue.dto';
import { ResourceAllocationRequestQueueService } from './resource-allocation-request-queue.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

interface QueueFilters {
  limit?: string;
  cursor?: string;
  groupId?: string;
  initiativeId?: string;
  resourceProfileId?: string;
  decisionState?: string;
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
@Controller()
export class ResourceAllocationRequestQueueController {
  constructor(
    @Inject(ResourceAllocationRequestQueueService)
    private readonly requestService: ResourceAllocationRequestQueueService,
  ) {}

  @Get('request-queues/:queueCode')
  @ApiOperation({ summary: 'List request work visible to the current role and scope' })
  @ApiSecurity('localProfile')
  @ApiParam({ name: 'queueCode', enum: ['presentation', 'team-decision'] })
  @ApiOkResponse({ type: RequestQueueCollectionDto, description: 'Scoped cursor-paginated request queue.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'groupId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'initiativeId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'resourceProfileId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'decisionState', required: false, type: String })
  @ApiForbiddenResponse({ description: 'The active role is not allowed to view this queue or group.' })
  @ApiResponse({ status: 400, description: 'The queue, filters, page size, or cursor is invalid.' })
  listQueue(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('queueCode') queueCode: string,
    @Query() filters: QueueFilters,
  ) {
    return this.requestService.listQueue(localUserId, queueCode, filters);
  }

  @Post('requests/:id/referrals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refer a request waiting for presentation to its active group leaders' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact referral action.' })
  @ApiOkResponse({ description: 'The request now waits for its group decision.', headers: { ETag: { schema: { type: 'string', example: '"2"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may refer requests.' })
  @ApiNotFoundResponse({ description: 'The request was not found in the operation.' })
  @ApiResponse({ status: 400, description: 'If-Match, Idempotency-Key, or request body is invalid.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The request changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The request cannot be referred in its current state or its references are not eligible.' })
  async refer(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(ReferRequestDto)) input: ReferRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.requestService.refer(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    response.setHeader('ETag', `"${operation.result.version}"`);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }

  @Post('requests/:id/reference-corrections')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Correct eligible references on a waiting request with an explanation' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact correction action.' })
  @ApiOkResponse({ description: 'The corrected request remains in its current presentation stage.', headers: { ETag: { schema: { type: 'string', example: '"2"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may correct request references.' })
  @ApiNotFoundResponse({ description: 'The request was not found in the operation.' })
  @ApiResponse({ status: 400, description: 'The body, If-Match, or Idempotency-Key is invalid.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The request changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The reference correction is not allowed or a selected reference is inactive.' })
  async correctReferences(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(CorrectRequestReferencesDto)) input: CorrectRequestReferencesDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.requestService.correctReferences(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    response.setHeader('ETag', `"${operation.result.version}"`);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }

  @Post('requests/:id/administrative-removals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove another requester’s waiting request from the operation while retaining its audit' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact removal action.' })
  @ApiOkResponse({ type: RemovedRequestReceiptDto, headers: { 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiForbiddenResponse({ description: 'Only an active Admin may remove another person’s waiting request.' })
  @ApiNotFoundResponse({ description: 'The request was not found in the operation.' })
  @ApiResponse({ status: 400, description: 'The body, If-Match, or Idempotency-Key is invalid.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The request changed since it was read.' })
  @ApiResponse({ status: 422, description: 'The request cannot be removed from its current state.' })
  async removeAdministratively(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(AdministrativeRequestRemovalDto)) input: AdministrativeRequestRemovalDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.requestService.removeAdministratively(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }
}
