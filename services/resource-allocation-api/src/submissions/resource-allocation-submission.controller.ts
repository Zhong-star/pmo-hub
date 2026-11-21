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
  ApiAcceptedResponse,
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
import { localProfileHeader } from '../access/resource-allocation-problem';
import { ResourceAllocationSubmissionService } from './resource-allocation-submission.service';
import {
  CreateResourceSubmissionRequestDto,
  ResourceSubmissionCollectionResponseDto,
  ResourceSubmissionLineResponseDto,
  ResourceSubmissionLineCollectionResponseDto,
  ResourceSubmissionResponseDto,
} from './submission-request.dto';

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

@ApiTags('Tech Resource Allocation submissions')
@Controller('submissions')
export class ResourceAllocationSubmissionController {
  constructor(
    @Inject(ResourceAllocationSubmissionService)
    private readonly submissionService: ResourceAllocationSubmissionService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Durably receive a batch of resource request lines' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID identifying this exact submission envelope.' })
  @ApiAcceptedResponse({ type: ResourceSubmissionResponseDto, headers: {
    Location: { schema: { type: 'string' } },
    'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } },
  } })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiResponse({ status: 400, description: 'The envelope, line structure, or idempotency key is invalid.' })
  @ApiResponse({ status: 409, description: 'The key was reused with changed content or a line attempt key already exists.' })
  @ApiResponse({ status: 503, description: 'The Resource Allocation database is unavailable.' })
  async receive(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(validatedBody(CreateResourceSubmissionRequestDto)) input: CreateResourceSubmissionRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const { result: submission, replayed } = await this.submissionService.receive(localUserId, idempotencyKey, correlationId, input);
    response.setHeader('Location', `/api/resource-allocation/v1/submissions/${submission.id}`);
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    return submission;
  }

  @Get()
  @ApiOperation({ summary: 'List the current user’s durable submission receipts' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceSubmissionCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  list(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.submissionService.list(localUserId, { limit, cursor });
  }

  @Get(':id/lines')
  @ApiOperation({ summary: 'List the current user’s results for an accepted submission' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceSubmissionLineCollectionResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The submission does not exist for this user.' })
  listLines(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.submissionService.listLines(localUserId, id, { limit, cursor });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Recover the current user’s durable submission receipt' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceSubmissionLineResponseDto })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The submission does not exist for this user.' })
  get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.submissionService.get(localUserId, id);
  }
}

@ApiTags('Tech Resource Allocation operation results')
@Controller('operation-results')
export class ResourceAllocationOperationResultController {
  constructor(
    @Inject(ResourceAllocationSubmissionService)
    private readonly submissionService: ResourceAllocationSubmissionService,
  ) {}

  @Get(':attemptKey')
  @ApiOperation({ summary: 'Recover a result by its original line attempt key' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceSubmissionResponseDto })
  @ApiQuery({ name: 'operation', required: true, enum: ['submission.create'] })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'No result exists for this user and operation.' })
  @ApiResponse({ status: 400, description: 'The original operation identifier is required.' })
  get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('attemptKey', new ParseUUIDPipe()) attemptKey: string,
    @Query('operation') operation?: string,
  ) {
    return this.submissionService.getOperationResult(localUserId, attemptKey, operation);
  }
}
