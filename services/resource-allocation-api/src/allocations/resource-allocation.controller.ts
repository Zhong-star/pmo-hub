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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { localProfileHeader } from '../access/resource-allocation-problem';
import {
  AllocationCollectionQueryDto,
  AllocationCollectionResponseDto,
  AllocationCommandDto,
  AllocationHistoryCollectionResponseDto,
  AllocationLoadQueryDto,
  AllocationLoadResponseDto,
  AllocationViewDto,
} from './allocation.dto';
import { ResourceAllocationService } from './resource-allocation.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

const collectionQueryValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: AllocationCollectionQueryDto });
const loadQueryValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: AllocationLoadQueryDto });
const commandValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: AllocationCommandDto });

@ApiTags('Tech Resource Allocations')
@ApiSecurity('localProfile')
@ApiUnauthorizedResponse({ description: 'Select an active local profile.' })
@ApiServiceUnavailableResponse({ description: 'The Resource Allocation database is unavailable.' })
@Controller()
export class ResourceAllocationController {
  constructor(
    @Inject(ResourceAllocationService)
    private readonly allocationService: ResourceAllocationService,
  ) {}

  @Get('allocations')
  @ApiOperation({ summary: 'List allocations visible to the current person, leadership scope, or Admin' })
  @ApiOkResponse({ type: AllocationCollectionResponseDto })
  @ApiBadRequestResponse({ description: 'A filter, limit, or cursor is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation profile is required.' })
  list(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query(collectionQueryValidation) query: AllocationCollectionQueryDto,
  ) {
    return this.allocationService.list(localUserId, query);
  }

  @Get('allocations/:id')
  @ApiOperation({ summary: 'Read an allocation and its approved and effective periods' })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string', example: '"1"' } } } })
  @ApiNotFoundResponse({ description: 'The allocation does not exist.' })
  @ApiForbiddenResponse({ description: 'The current profile is outside the allocation scope.' })
  async get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const allocation = await this.allocationService.get(localUserId, id);
    response.setHeader('ETag', `"${allocation.version}"`);
    return allocation;
  }

  @Get('allocation-load')
  @ApiOperation({ summary: 'Sum contracted weekly hours by person and operational state on a date' })
  @ApiOkResponse({ type: AllocationLoadResponseDto })
  @ApiQuery({ name: 'date', required: true, type: String, format: 'date' })
  @ApiBadRequestResponse({ description: 'The date, filter, limit, or cursor is invalid.' })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation profile is required.' })
  load(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query(loadQueryValidation) query: AllocationLoadQueryDto,
  ) {
    return this.allocationService.load(localUserId, query);
  }

  @Get('allocations/:id/history')
  @ApiOperation({ summary: 'Read immutable operational history for an allocation' })
  @ApiOkResponse({ type: AllocationHistoryCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiNotFoundResponse({ description: 'The allocation does not exist.' })
  @ApiForbiddenResponse({ description: 'The current profile is outside the allocation scope.' })
  history(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.allocationService.listHistory(localUserId, id, { limit, cursor });
  }

  @Post('allocations/:id/suspensions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend an allocation' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong allocation ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact state command.' })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The allocation cannot be suspended from its current state.' })
  async suspend(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'suspend', ifMatch, key, correlationId, input, response);
  }

  @Post('allocations/:id/reservations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reserve an allocation without action' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The allocation cannot be reserved from its current state.' })
  async reserve(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'reserve', ifMatch, key, correlationId, input, response);
  }

  @Post('allocations/:id/resumptions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a suspended allocation' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'Only a suspended allocation can be resumed.' })
  async resume(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'resume', ifMatch, key, correlationId, input, response);
  }

  @Post('allocations/:id/activations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate an allocation reserved without action' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'Only a reserved allocation can be activated.' })
  async activate(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'activate', ifMatch, key, correlationId, input, response);
  }

  @Post('allocations/:id/completions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete an allocation that has started' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'A future or closed allocation cannot be completed.' })
  async complete(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'complete', ifMatch, key, correlationId, input, response);
  }

  @Post('allocations/:id/cancellations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open allocation' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-ID', required: false })
  @ApiOkResponse({ type: AllocationViewDto, headers: { ETag: { schema: { type: 'string' } }, 'Idempotency-Replayed': { schema: { type: 'string' } } } })
  @ApiBadRequestResponse({ description: 'A required header or reason is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The allocation version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'A closed allocation cannot be canceled.' })
  async cancel(@Headers(localProfileHeader) userId: string | undefined, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined, @Body(commandValidation) input: AllocationCommandDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders) {
    return this.change(userId, id, 'cancel', ifMatch, key, correlationId, input, response);
  }

  private async change(
    userId: string | undefined,
    id: string,
    command: 'suspend' | 'reserve' | 'resume' | 'activate' | 'complete' | 'cancel',
    ifMatch: string | undefined,
    key: string | undefined,
    correlationId: string | undefined,
    input: AllocationCommandDto,
    response: ResponseWithHeaders,
  ) {
    const operation = await this.allocationService.changeState(userId, id, command, ifMatch, key, correlationId, input);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }
}
