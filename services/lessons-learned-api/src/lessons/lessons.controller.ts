import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseFilters,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import { LessonDraftResponse } from './lesson-response.dto';
import { LessonsService } from './lessons.service';
import { LessonProjectResponse } from './project-response.dto';
import { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';

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

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Update an author-owned Open lesson draft using its expected version' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'The numeric ID of the lesson draft.' })
  @ApiBody({ type: UpdateLessonDraftRequest })
  @ApiOkResponse({ type: LessonDraftResponse })
  @ApiResponse({ status: 400, description: 'The draft fields or project selection are invalid.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile has no active Lessons Learned access.' })
  @ApiResponse({ status: 404, description: 'The lesson does not exist or is not owned by the selected profile.' })
  @ApiResponse({ status: 409, description: 'The draft changed after it was loaded or is no longer Open.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  updateOwnOpenDraft(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParseIntPipe) lessonId: number,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: UpdateLessonDraftRequest }))
    input: UpdateLessonDraftRequest,
  ): Promise<LessonDraftResponse> {
    return this.lessons.updateOwnOpenDraft(typeof header === 'string' ? header : undefined, lessonId, input);
  }
}
