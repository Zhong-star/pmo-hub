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
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import {
  CancelDeniedRequestDto,
  ContestRequestDto,
  DenyRequestDto,
  RequestDecisionResponseDto,
  RequestHistoryCollectionDto,
  RequestHistoryQueryDto,
} from './request-decision.dto';
import { RecordRequestStrategyDto, ResolveRequestExceptionDto } from './resolve-exception.dto';
import { ResourceAllocationDecisionService } from './resource-allocation-decision.service';

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

@ApiTags('Tech Resource Allocation decisions')
@ApiSecurity('localProfile')
@Controller()
export class ResourceAllocationDecisionController {
  constructor(
    @Inject(ResourceAllocationDecisionService)
    private readonly decisions: ResourceAllocationDecisionService,
  ) {}

  @Post('requests/:id/denials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deny a request awaiting a decision with an explanation' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact denial action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or explanation is invalid.' })
  @ApiForbiddenResponse({ description: 'The actor is not a current in-scope decision maker or is the requester.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not awaiting a decision or its deadline has passed.' })
  async deny(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(DenyRequestDto)) input: DenyRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.deny(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Post('requests/:id/contests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Contest a denial or a changed proposal and send it to Pre N3' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact contest action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or explanation is invalid.' })
  @ApiForbiddenResponse({ description: 'Only the current requester can contest the denial.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational or does not belong to the requester.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not contestable or its denial/proposal response deadline has passed.' })
  async contest(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(ContestRequestDto)) input: ContestRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.contest(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Post('requests/:id/cancellations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a denied request as requester or a Pre N3/Escalation request as Admin' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact cancellation action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or reason is invalid.' })
  @ApiForbiddenResponse({ description: 'The actor is not the requester canceling a denial or an Admin canceling another requester’s exception.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational or does not belong to the requester.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not in a cancellable state or its denial response deadline has passed.' })
  async cancelDenied(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(CancelDeniedRequestDto)) input: CancelDeniedRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.cancelDenied(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Post('requests/:id/escalations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explicitly escalate a Pre N3 request as an Admin' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact escalation action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or reason is invalid.' })
  @ApiForbiddenResponse({ description: 'Only an active Admin other than the requester may escalate the request.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'Only a Pre N3 request may be escalated.' })
  async escalate(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(CancelDeniedRequestDto)) input: CancelDeniedRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.escalate(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Post('requests/:id/strategies')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record an exception strategy without assigning a person or approving the request' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact strategy action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'The strategy, affected initiative IDs, reason, or command headers are invalid.' })
  @ApiForbiddenResponse({ description: 'Only an active Admin other than the requester may resolve the exception.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not in Pre N3/Escalation or an affected ITDM is inactive.' })
  async recordStrategy(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(RecordRequestStrategyDto)) input: RecordRequestStrategyDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.recordStrategy(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Post('requests/:id/resolutions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a Pre N3/Escalation request through a final strategy resolution without requester acceptance' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact resolution action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'The strategy, final conditions, affected initiative IDs, reason, or command headers are invalid.' })
  @ApiForbiddenResponse({ description: 'Only an active Admin other than the requester may resolve the exception.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not in Pre N3/Escalation or final conditions are not currently eligible.' })
  async resolveException(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(ResolveRequestExceptionDto)) input: ResolveRequestExceptionDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.decisions.resolveException(localUserId, id, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }

  @Get('requests/:id/history')
  @ApiOperation({ summary: 'Read request history as its requester or a leader/Admin currently authorized to consult the request' })
  @ApiOkResponse({ type: RequestHistoryCollectionDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiBadRequestResponse({ description: 'The page cursor or limit is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The request is not operational or is outside the caller’s current read scope.' })
  getHistory(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) query: RequestHistoryQueryDto,
  ) {
    return this.decisions.getHistory(localUserId, id, query);
  }
}
