import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  LocalAccessProblem,
  LocalAccessProblemFilter,
  localProfileHeader,
  localProfileScheme,
} from '../local-access-problem';
import { CreateLessonRequest } from './create-lesson-request.dto';
import { ApproveLessonRequest } from './approve-lesson-request.dto';
import { CancelLessonRequest } from './cancel-lesson-request.dto';
import { LessonDetailsResponse, LessonDraftResponse } from './lesson-response.dto';
import { LessonConflictResponse } from './lesson-conflict-response.dto';
import { LessonSubmissionValidationResponse } from './lesson-submission-validation-response.dto';
import { LessonEditValidationResponse } from './lesson-edit-validation-response.dto';
import { LessonCancellationValidationResponse } from './lesson-cancellation-validation-response.dto';
import { LessonReturnValidationResponse } from './lesson-return-validation-response.dto';
import { LessonsService } from './lessons.service';
import { LessonProjectResponse } from './project-response.dto';
import { SubmitLessonRequest } from './submit-lesson-request.dto';
import { ReturnLessonRequest } from './return-lesson-request.dto';
import { LessonRejectionValidationResponse } from './lesson-rejection-validation-response.dto';
import { RejectLessonRequest } from './reject-lesson-request.dto';
import { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';
import {
  LessonSubmissionsQuery,
  PmoDraftsQuery,
  PmoEvaluationQueueQuery,
} from './lesson-submissions-query.dto';
import { LESSON_STATUSES, LESSON_TYPES } from './lesson-domain.constants';

@ApiTags('Lessons')
@ApiExtraModels(LocalAccessProblem)
@Controller('lessons')
@UseFilters(LocalAccessProblemFilter)
export class LessonsController {
  constructor(@Inject(LessonsService) private readonly lessons: LessonsService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a title-only Open lesson draft for the selected profile' })
  @ApiSecurity(localProfileScheme)
  @ApiBody({ type: CreateLessonRequest })
  @ApiCreatedResponse({ type: LessonDraftResponse })
  @ApiResponse({ status: 400, description: 'The title must contain 1 to 150 characters.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  createDraft(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: CreateLessonRequest }))
    input: CreateLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.createDraft(typeof header === 'string' ? header : undefined, input);
  }

  @Get('projects')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List fictional local projects available for lesson drafts' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: LessonProjectResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  getProjects(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
  ): LessonProjectResponse[] {
    return this.lessons.getProjects(typeof header === 'string' ? header : undefined);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List the selected profile’s Open lesson drafts' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: LessonDraftResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getMyOpenDrafts(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
  ): Promise<LessonDraftResponse[]> {
    return this.lessons.getMyOpenDrafts(typeof header === 'string' ? header : undefined);
  }

  @Get('mine')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List the selected profile’s own submissions across all statuses' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'status', required: false, enum: LESSON_STATUSES })
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter to lessons without a project.' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Title prefix or exact numeric lesson ID.' })
  @ApiOkResponse({ type: LessonDraftResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getMySubmissions(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: LessonSubmissionsQuery }))
    filters: LessonSubmissionsQuery,
  ): Promise<LessonDraftResponse[]> {
    return this.lessons.getMySubmissions(typeof header === 'string' ? header : undefined, filters);
  }

  @Get('pmo-drafts')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List module lessons for PMO Drafts, optionally filtered by author, project, type, status, and search' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'authorId', required: false, type: String, description: 'Author profile ID.' })
  @ApiQuery({ name: 'status', required: false, enum: LESSON_STATUSES })
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter to lessons without a project.' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Title prefix or exact numeric lesson ID.' })
  @ApiOkResponse({ type: LessonDraftResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getPmoDrafts(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: PmoDraftsQuery }))
    filters: PmoDraftsQuery,
  ): Promise<LessonDraftResponse[]> {
    return this.lessons.getPmoDrafts(typeof header === 'string' ? header : undefined, filters);
  }

  @Get('evaluation-queue')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List lessons awaiting PMO evaluation, oldest last submission first' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter to lessons without a project.' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Title prefix or exact numeric lesson ID.' })
  @ApiOkResponse({ type: LessonDraftResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getPmoEvaluationQueue(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: PmoEvaluationQueueQuery }))
    filters: PmoEvaluationQueueQuery,
  ): Promise<LessonDraftResponse[]> {
    return this.lessons.getPmoEvaluationQueue(typeof header === 'string' ? header : undefined, filters);
  }

  @Get('library')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List published lessons by most recent approval date' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: LessonDraftResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getLibrary(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
  ): Promise<LessonDraftResponse[]> {
    return this.lessons.getLibrary(typeof header === 'string' ? header : undefined);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get an author-owned or PMO-accessible lesson and its lifecycle history' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson.' })
  @ApiOkResponse({ type: LessonDetailsResponse })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not visible to the selected profile.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getLessonDetails(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
  ): Promise<LessonDetailsResponse> {
    return this.lessons.getLessonDetails(typeof header === 'string' ? header : undefined, lessonId);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Update an Open lesson draft or a PMO evaluation while preserving its lifecycle state' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson draft.' })
  @ApiBody({ type: UpdateLessonDraftRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({
    type: LessonEditValidationResponse,
    description: 'The lesson fields or project selection are invalid; fieldErrors identifies fields to correct.',
  })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not editable by the selected profile.' })
  @ApiConflictResponse({
    type: LessonConflictResponse,
    description: 'The draft changed after it was loaded or is no longer Open.',
  })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  updateOpenDraft(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: UpdateLessonDraftRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_LESSON_EDIT',
        message: 'Correct the indicated fields before saving.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: UpdateLessonDraftRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.updateOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Submit a complete author-owned Open lesson for PMO evaluation' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson draft.' })
  @ApiBody({ type: SubmitLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({
    type: LessonSubmissionValidationResponse,
    description: 'Submission fields are invalid; fieldErrors identifies the fields to correct.',
  })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not owned by the selected profile.' })
  @ApiConflictResponse({
    type: LessonConflictResponse,
    description: 'The lesson is no longer Open or the submitted version is stale.',
  })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  submitOwnOpenDraft(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: SubmitLessonRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_LESSON_SUBMISSION',
        message: 'Correct the indicated fields before submitting.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: SubmitLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.submitOwnOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/return')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Return a lesson awaiting PMO evaluation to its author with required guidance' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson awaiting evaluation.' })
  @ApiBody({ type: ReturnLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({
    type: LessonReturnValidationResponse,
    description: 'Return guidance must contain non-whitespace text and be no longer than 1000 characters.',
  })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist.' })
  @ApiConflictResponse({
    type: LessonConflictResponse,
    description: 'The lesson is no longer awaiting evaluation or the supplied version is stale.',
  })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  returnForChanges(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: ReturnLessonRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_LESSON_RETURN',
        message: 'Enter guidance for the author with no more than 1000 characters.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: ReturnLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.returnForChanges(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cancel an Open lesson owned by the selected profile or managed by a PMO' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson draft.' })
  @ApiBody({ type: CancelLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({
    type: LessonCancellationValidationResponse,
    description: 'The cancellation reason is invalid; fieldErrors identifies the field to correct.',
  })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not cancellable by the selected profile.' })
  @ApiConflictResponse({
    type: LessonConflictResponse,
    description: 'The lesson is no longer Open or the cancelled version is stale.',
  })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  cancelOpenDraft(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: CancelLessonRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_LESSON_CANCELLATION',
        message: 'Enter a valid cancellation reason.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: CancelLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.cancelOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Approve and publish the version reviewed by a PMO moderator' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson under evaluation.' })
  @ApiBody({ type: ApproveLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({ description: 'The lesson is incomplete and cannot be approved.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist.' })
  @ApiConflictResponse({ type: LessonConflictResponse, description: 'The lesson is no longer awaiting evaluation or its version is stale.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  approveEvaluatedLesson(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: ApproveLessonRequest }))
    input: ApproveLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.approveEvaluatedLesson(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Reject a lesson awaiting PMO evaluation with a recorded reason' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson under evaluation.' })
  @ApiBody({ type: RejectLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiBadRequestResponse({
    type: LessonRejectionValidationResponse,
    description: 'The rejection reason is invalid; fieldErrors identifies the field to correct.',
  })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist.' })
  @ApiConflictResponse({
    type: LessonConflictResponse,
    description: 'The lesson is no longer awaiting PMO evaluation or the version is stale.',
  })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  rejectEvaluation(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: RejectLessonRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_LESSON_REJECTION',
        message: 'Enter a valid rejection reason.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: RejectLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.rejectEvaluation(typeof header === 'string' ? header : undefined, lessonId, input);
  }
}
