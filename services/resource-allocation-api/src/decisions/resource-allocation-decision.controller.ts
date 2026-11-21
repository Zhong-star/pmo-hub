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
    response.setHeader('ETag', `"${operation.result.version}"`);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }

  @Post('requests/:id/contests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Contest a denied request and send it to Pre N3' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact contest action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or explanation is invalid.' })
  @ApiForbiddenResponse({ description: 'Only the current requester can contest the denial.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational or does not belong to the requester.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not denied or the 14-day response deadline has passed.' })
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
    response.setHeader('ETag', `"${operation.result.version}"`);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }

  @Post('requests/:id/cancellations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a denied request with a reason' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact cancellation action.' })
  @ApiOkResponse({ type: RequestDecisionResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or reason is invalid.' })
  @ApiForbiddenResponse({ description: 'Only the current requester can cancel a denied request.' })
  @ApiNotFoundResponse({ description: 'The request is no longer operational or does not belong to the requester.' })
  @ApiResponse({ status: 409, description: 'The Idempotency-Key was reused with different request content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is not denied or the 14-day response deadline has passed.' })
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
    response.setHeader('ETag', `"${operation.result.version}"`);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return operation.result;
  }

  @Get('requests/:id/history')
  @ApiOperation({ summary: 'Read request history as its requester' })
  @ApiOkResponse({ type: RequestHistoryCollectionDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiBadRequestResponse({ description: 'The page cursor or limit is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The request is not operational or does not belong to this requester.' })
  getHistory(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) query: RequestHistoryQueryDto,
  ) {
    return this.decisions.getHistory(localUserId, id, query);
  }
}
