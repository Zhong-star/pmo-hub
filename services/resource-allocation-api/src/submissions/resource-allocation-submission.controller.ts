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
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ProtectedResourceProblems } from '../access/problem-response.decorator';
import { createValidationPipe, localProfileHeader } from '../access/resource-allocation-problem';
import {
  ResourceAllocationOperationResultService,
  supportedIdempotentOperations,
} from '../administration/idempotency/resource-allocation-operation-result.service';
import {
  ResourceGroupResponseDto,
  ResourcePersonResponseDto,
  ResourceProfileResponseDto,
} from '../administration/resource-administration.dto';
import { AllocationViewDto } from '../allocations/allocation.dto';
import { ApproveRequestResponseDto } from '../approvals/approve-request.dto';
import { RequestDecisionResponseDto } from '../decisions/request-decision.dto';
import { ResourceInitiativeResponseDto } from '../initiatives/initiative-request.dto';
import { ResourceNotificationDto, ResourceNotificationReadAllDto } from '../notifications/resource-allocation-notification.dto';
import { RemovedRequestReceiptDto, RequestChangeReceiptDto } from '../requests/request-queue.dto';
import { ResourceRequestAuditEventResponseDto } from '../requests/request.dto';
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

const validatedBody = createValidationPipe;

@ApiTags('Tech Resource Allocation submissions')
@ProtectedResourceProblems()
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
  @ApiOkResponse({ type: ResourceSubmissionResponseDto })
  @ApiForbiddenResponse({ description: 'An active Resource Allocation person record is required.' })
  @ApiNotFoundResponse({ description: 'The submission does not exist for this user.' })
  get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.submissionService.get(localUserId, id);
  }
}

const operationResultResponseDtos = [
  ResourceSubmissionLineResponseDto,
  ResourceSubmissionResponseDto,
  ResourcePersonResponseDto,
  ResourceGroupResponseDto,
  ResourceProfileResponseDto,
  ResourceInitiativeResponseDto,
  ResourceRequestAuditEventResponseDto,
  RequestChangeReceiptDto,
  RemovedRequestReceiptDto,
  ApproveRequestResponseDto,
  RequestDecisionResponseDto,
  AllocationViewDto,
  ResourceNotificationDto,
  ResourceNotificationReadAllDto,
] as const;

@ApiTags('Tech Resource Allocation operation results')
@ProtectedResourceProblems()
@ApiExtraModels(...operationResultResponseDtos)
@Controller('operation-results')
export class ResourceAllocationOperationResultController {
  constructor(
    @Inject(ResourceAllocationOperationResultService)
    private readonly operationResultService: ResourceAllocationOperationResultService,
  ) {}

  @Get(':attemptKey')
  @ApiOperation({ summary: 'Recover an authorized operation receipt by its original attempt or idempotency key' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({
    description: 'The stored result for the owning active actor without re-executing mutations or emitting a current ETag header.',
    schema: {
      oneOf: operationResultResponseDtos.map((dto) => ({ $ref: getSchemaPath(dto) })),
    },
  })
  @ApiQuery({ name: 'operation', required: true, enum: [...supportedIdempotentOperations] })
  @ApiForbiddenResponse({ description: 'An active profile with current access to this operation result is required.' })
  @ApiNotFoundResponse({ description: 'No result exists for this user and operation.' })
  @ApiResponse({ status: 400, description: 'The attempt key or operation identifier is invalid.' })
  get(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('attemptKey', new ParseUUIDPipe()) attemptKey: string,
    @Query('operation') operation?: string,
  ) {
    return this.operationResultService.getOperationResult(localUserId, attemptKey, operation);
  }
}
