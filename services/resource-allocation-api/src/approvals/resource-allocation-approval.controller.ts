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
import { ProtectedResourceProblems } from '../access/problem-response.decorator';
import { createValidationPipe, localProfileHeader } from '../access/resource-allocation-problem';
import { AcceptRequestChangesDto, ApprovalCandidateCollectionDto, ApprovalCandidateQueryDto, ApproveRequestDto, ApproveRequestResponseDto } from './approve-request.dto';
import { ResourceAllocationApprovalService } from './resource-allocation-approval.service';
import { ResourceAllocationProposalResponseService } from './resource-allocation-proposal-response.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

@ApiTags('Tech Resource Allocation approvals')
@ApiSecurity('localProfile')
@ProtectedResourceProblems()
@Controller('requests')
export class ResourceAllocationApprovalController {
  constructor(
    @Inject(ResourceAllocationApprovalService)
    private readonly approvalService: ResourceAllocationApprovalService,
    @Inject(ResourceAllocationProposalResponseService)
    private readonly proposalResponseService: ResourceAllocationProposalResponseService,
  ) {}

  @Get(':id/approval-candidates')
  @ApiOperation({ summary: 'List eligible people for an in-scope approval or a global Admin exception resolution' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: ApprovalCandidateCollectionDto, description: 'Active people in the request group with only their identifier and display name.' })
  @ApiForbiddenResponse({ description: 'The actor is not an authorized in-scope decider or global Admin, or the request is their own.' })
  @ApiNotFoundResponse({ description: 'The current request was not found.' })
  @ApiBadRequestResponse({ description: 'The limit or cursor is invalid.' })
  async listApprovalCandidates(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) requestId: string,
    @Query(createValidationPipe(ApprovalCandidateQueryDto)) query: ApprovalCandidateQueryDto,
  ) {
    return this.approvalService.listCandidates(localUserId, requestId, query);
  }

  @Post(':id/approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a request with the requested period and hours' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact approval action.' })
  @ApiOkResponse({ type: ApproveRequestResponseDto, headers: { ETag: { schema: { type: 'string', example: '"2"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or approval body is invalid.' })
  @ApiForbiddenResponse({ description: 'The actor is not an authorized in-scope decider or is approving their own request.' })
  @ApiNotFoundResponse({ description: 'The current request was not found.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request is ineligible, expired, or cannot be approved in its current state.' })
  async approve(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(createValidationPipe(ApproveRequestDto)) input: ApproveRequestDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const operation = await this.approvalService.approve(localUserId, requestId, ifMatch, idempotencyKey, correlationId, input);
    if (operation.replayed) {
      response.setHeader('Idempotency-Replayed', 'true');
    } else {
      response.setHeader('ETag', `"${operation.result.version}"`);
    }
    return operation.result;
  }

  @Post(':id/acceptances')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a changed proposal before its deadline, or apply the automatic deadline transition' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current strong request ETag.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID for this exact acceptance action.' })
  @ApiOkResponse({ type: ApproveRequestResponseDto, headers: { ETag: { schema: { type: 'string', example: '"3"' } }, 'Idempotency-Replayed': { schema: { type: 'string', example: 'true' } } } })
  @ApiBadRequestResponse({ description: 'If-Match, Idempotency-Key, correlation ID, or body is invalid.' })
  @ApiForbiddenResponse({ description: 'Only the requester may accept this proposal.' })
  @ApiNotFoundResponse({ description: 'The current request was not found.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was reused with different content.' })
  @ApiResponse({ status: 412, description: 'The request version changed.' })
  @ApiUnprocessableEntityResponse({ description: 'The request has no pending proposal. At the deadline the automatic transition takes precedence.' })
  async acceptChanges(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body(createValidationPipe(AcceptRequestChangesDto)) _input: AcceptRequestChangesDto,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    void _input;
    const operation = await this.proposalResponseService.acceptChanges(localUserId, requestId, ifMatch, idempotencyKey, correlationId);
    if (operation.replayed) response.setHeader('Idempotency-Replayed', 'true');
    else response.setHeader('ETag', `"${operation.result.version}"`);
    return operation.result;
  }
}
