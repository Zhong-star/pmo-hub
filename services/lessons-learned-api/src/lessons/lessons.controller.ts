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
  UseInterceptors,
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
  getSchemaPath,
} from '@nestjs/swagger';
import {
  LocalAccessProblem,
  LocalAccessProblemFilter,
  localProfileHeader,
  localProfileScheme,
} from '../local-access-problem';
import { CreateLessonRequest } from './create-lesson-request.dto';
import { ApproveLessonRequest } from './approve-lesson-request.dto';
import { CloseLessonRequest } from './close-lesson-request.dto';
import { CancelLessonRequest } from './cancel-lesson-request.dto';
import {
  LessonDetailsResponse, LessonDraftResponse, LessonLibraryResponse, RecordLessonLibraryViewResponse,
} from './lesson-response.dto';
import { LessonConflictResponse } from './lesson-conflict-response.dto';
import { LessonSubmissionValidationResponse } from './lesson-submission-validation-response.dto';
import { LessonEditValidationResponse } from './lesson-edit-validation-response.dto';
import { LessonCancellationValidationResponse } from './lesson-cancellation-validation-response.dto';
import { LessonReturnValidationResponse } from './lesson-return-validation-response.dto';
import { CreateLessonCommentRequest } from './create-lesson-comment-request.dto';
import { HideLessonCommentRequest } from './hide-lesson-comment-request.dto';
import {
  LessonCommentItemResponse,
  LessonCommentPageResponse,
  LessonCommentThreadResponse,
} from './lesson-comment-response.dto';
import { LessonCommentsService } from './lesson-comments.service';
import { LessonsService } from './lessons.service';
import { LessonProjectResponse } from './project-response.dto';
import { SubmitLessonRequest } from './submit-lesson-request.dto';
import { ReturnLessonRequest } from './return-lesson-request.dto';
import { LessonRejectionValidationResponse } from './lesson-rejection-validation-response.dto';
import { RejectLessonRequest } from './reject-lesson-request.dto';
import { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';
import {
  LESSON_LIBRARY_SORTS,
  LessonSubmissionsQuery,
  LessonsLibraryQuery,
  PmoDraftsQuery,
  PmoEvaluationQueueQuery,
} from './lesson-submissions-query.dto';
import { ConditionalLessonWrite, LessonHttpContract, LessonProblem, LessonProblemFilter } from './lesson-http-contract';
import { LessonLibraryPage, LessonPage, LessonProjectPage, readPageRequest } from './lesson-pagination';
import { RecordLibraryViewRequest } from './record-library-view-request.dto';
import { ParsePositivePostgresIntegerPipe } from './parse-positive-postgres-integer.pipe';
import { LESSON_STATUSES, LESSON_TYPES } from './lesson-domain.constants';

@ApiTags('Lessons')
@ApiExtraModels(
  LocalAccessProblem,
  LessonCommentItemResponse,
  LessonCommentPageResponse,
  LessonCommentThreadResponse,
  LessonLibraryPage,
  LessonLibraryResponse,
  LessonPage,
  LessonProblem,
  LessonProjectPage,
)
@Controller('lessons')
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class LessonsController {
  constructor(
    @Inject(LessonsService) private readonly lessons: LessonsService,
    @Inject(LessonCommentsService) private readonly comments: LessonCommentsService,
  ) {}

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
  @ApiQuery({ name: 'paged', required: false, enum: ['true'], description: 'Opt in to the cursor response envelope.' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiOkResponse({ schema: { oneOf: [
    { type: 'array', items: { $ref: getSchemaPath(LessonDraftResponse) } },
    { $ref: getSchemaPath(LessonPage) },
  ] } })
  @ApiBadRequestResponse({ description: 'Invalid page limit or cursor for this query.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getPmoEvaluationQueue(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: PmoEvaluationQueueQuery }))
    filters: PmoEvaluationQueueQuery,
    @Query('paged') paged?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonDraftResponse[] | LessonPage> {
    return this.lessons.getPmoEvaluationQueue(typeof header === 'string' ? header : undefined, filters, readPageRequest(paged, cursor, limit));
  }

  @Get('evaluation-queue/projects')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List distinct project snapshots in the evaluation queue by ascending project ID' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'paged', required: false, enum: ['true'], description: 'Opt in to the cursor response envelope.' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiOkResponse({ schema: { oneOf: [
    { type: 'array', items: { $ref: getSchemaPath(LessonProjectResponse) } },
    { $ref: getSchemaPath(LessonProjectPage) },
  ] } })
  @ApiBadRequestResponse({ description: 'Invalid page limit or project cursor.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getEvaluationProjectSnapshots(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query('paged') paged?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonProjectResponse[] | LessonProjectPage> {
    return this.lessons.getEvaluationProjectSnapshots(
      typeof header === 'string' ? header : undefined, readPageRequest(paged, cursor, limit),
    );
  }

  @Get('library')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List published lessons with the selected sort order' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'paged', required: false, enum: ['true'], description: 'Opt in to the cursor response envelope.' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'A case- and accent-insensitive title prefix, numeric ID or #ID.' })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter lessons without a project.' })
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({ name: 'sort', required: false, enum: LESSON_LIBRARY_SORTS, default: 'newest', description: 'Sort the filtered published lessons before cursor pagination.' })
  @ApiOkResponse({ schema: { oneOf: [
    { type: 'array', items: { $ref: getSchemaPath(LessonLibraryResponse) } },
    { $ref: getSchemaPath(LessonLibraryPage) },
  ] } })
  @ApiBadRequestResponse({ description: 'Invalid page limit or cursor for this query.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getLibrary(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: LessonsLibraryQuery }))
    filters: LessonsLibraryQuery,
    @Query('paged') paged?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonLibraryResponse[] | LessonLibraryPage> {
    return this.lessons.getLibrary(
      typeof header === 'string' ? header : undefined,
      readPageRequest(paged, cursor, limit),
      filters,
    );
  }

  @Get('library/projects')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List project snapshots used by published Lessons Library entries' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: [LessonProjectResponse] })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getLibraryProjectSnapshots(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
  ): Promise<LessonProjectResponse[]> {
    return this.lessons.getLibraryProjectSnapshots(typeof header === 'string' ? header : undefined);
  }

  @Get('library/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get published lesson content and authorized lifecycle history for the Library detail URL' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the published lesson.' })
  @ApiOkResponse({ type: LessonDetailsResponse })
  @ApiBadRequestResponse({ description: 'The lesson ID is outside the supported range.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The published lesson does not exist or is not available in the Library.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getLibraryLessonDetails(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
  ): Promise<LessonDetailsResponse> {
    return this.lessons.getLibraryLessonDetails(typeof header === 'string' ? header : undefined, lessonId);
  }

  @Post('library/:id/views')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record one authorized opening of a published Library lesson' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'Positive PostgreSQL integer lesson ID.' })
  @ApiBody({ type: RecordLibraryViewRequest })
  @ApiOkResponse({ type: RecordLessonLibraryViewResponse })
  @ApiBadRequestResponse({ description: 'The lesson ID or opening UUID is invalid.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The published lesson does not exist or is not available in the Library.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  recordLibraryView(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: RecordLibraryViewRequest }))
    input: RecordLibraryViewRequest,
  ): Promise<RecordLessonLibraryViewResponse> {
    return this.lessons.recordLibraryView(typeof header === 'string' ? header : undefined, lessonId, input);
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
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
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
    return this.lessons.updateOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/submit')
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
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
    return this.lessons.submitOwnOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/return')
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
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
    return this.lessons.returnForChanges(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/cancel')
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
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
    return this.lessons.cancelOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/approve')
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: ApproveLessonRequest }))
    input: ApproveLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.approveEvaluatedLesson(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/reject')
  @ConditionalLessonWrite()
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
    @Headers('if-match') ifMatch: string | undefined,
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
    return this.lessons.rejectEvaluation(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Post(':id/close')
  @ConditionalLessonWrite()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Close an approved lesson while preserving its publication date' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the approved lesson.' })
  @ApiBody({ type: CloseLessonRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiResponse({ status: 400, description: 'The lesson version must be a positive integer.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist.' })
  @ApiConflictResponse({ type: LessonConflictResponse, description: 'The lesson is no longer Approved or its version is stale.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  closeApprovedLesson(
    @Headers('if-match') ifMatch: string | undefined,
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: CloseLessonRequest }))
    input: CloseLessonRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.closeApprovedLesson(typeof header === 'string' ? header : undefined, lessonId, input, ifMatch);
  }

  @Get(':id/comments')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List paginated root comments (newest first) with chronological single-level replies' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson.' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiQuery({ name: 'includeHidden', required: false, enum: ['true', 'false'], description: 'PMO-only flag to include hidden comments and moderation audit details.' })
  @ApiOkResponse({ type: LessonCommentPageResponse })
  @ApiBadRequestResponse({ description: 'Invalid lesson ID, page limit, cursor, or includeHidden flag.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not authorized or requested hidden comments without PMO access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not visible to the selected profile.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  listComments(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('includeHidden') includeHidden?: string,
  ): Promise<LessonCommentPageResponse> {
    return this.comments.listComments(typeof header === 'string' ? header : undefined, lessonId, {
      cursor,
      limit,
      includeHidden,
    });
  }

  @Post(':id/comments')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Post a top-level comment on an accessible lesson' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson.' })
  @ApiBody({ type: CreateLessonCommentRequest })
  @ApiCreatedResponse({ type: LessonCommentThreadResponse })
  @ApiBadRequestResponse({ description: 'Comment text must contain 1 to 2,000 non-whitespace characters.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not visible to the selected profile.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  createComment(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: CreateLessonCommentRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_COMMENT',
        message: 'Enter a comment between 1 and 2,000 characters.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: CreateLessonCommentRequest,
  ): Promise<LessonCommentThreadResponse> {
    return this.comments.createComment(typeof header === 'string' ? header : undefined, lessonId, input);
  }

  @Post(':id/comments/:commentId/replies')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Post a single-level reply to a top-level comment on an accessible lesson' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson.' })
  @ApiParam({ name: 'commentId', type: Number, description: 'The numeric ID of the parent root comment.' })
  @ApiBody({ type: CreateLessonCommentRequest })
  @ApiCreatedResponse({ type: LessonCommentItemResponse })
  @ApiBadRequestResponse({ description: 'Reply text is invalid or attempts to reply to another reply.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson or parent comment does not exist or is not visible.' })
  @ApiConflictResponse({ description: 'The parent comment is hidden and cannot receive new replies.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  createReply(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
    @Param('commentId', ParsePositivePostgresIntegerPipe) commentId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: CreateLessonCommentRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_COMMENT',
        message: 'Enter a reply between 1 and 2,000 characters.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: CreateLessonCommentRequest,
  ): Promise<LessonCommentItemResponse> {
    return this.comments.createReply(typeof header === 'string' ? header : undefined, lessonId, commentId, input);
  }

  @Post(':id/comments/:commentId/hide')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Hide a comment or reply as a PMO moderator with a mandatory reason' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson.' })
  @ApiParam({ name: 'commentId', type: Number, description: 'The numeric ID of the comment or reply to hide.' })
  @ApiBody({ type: HideLessonCommentRequest })
  @ApiOkResponse({ type: LessonCommentItemResponse })
  @ApiBadRequestResponse({ description: 'A moderation reason between 1 and 1,000 characters is required.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 404, description: 'The lesson or comment does not exist.' })
  @ApiConflictResponse({ description: 'The comment is already hidden.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  hideComment(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) lessonId: number,
    @Param('commentId', ParsePositivePostgresIntegerPipe) commentId: number,
    @Body(new ValidationPipe({
      transform: true,
      whitelist: true,
      expectedType: HideLessonCommentRequest,
      exceptionFactory: (errors) => new BadRequestException({
        code: 'INVALID_COMMENT_MODERATION',
        message: 'Enter a moderation reason between 1 and 1,000 characters.',
        fieldErrors: Object.fromEntries(errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ?? 'Invalid value.',
        ])),
      }),
    }))
    input: HideLessonCommentRequest,
  ): Promise<LessonCommentItemResponse> {
    return this.comments.hideComment(typeof header === 'string' ? header : undefined, lessonId, commentId, input);
  }
}
