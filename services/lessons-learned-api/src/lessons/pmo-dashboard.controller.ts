import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
  UseFilters,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
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
import { LESSON_STATUSES, LESSON_TYPES } from './lesson-domain.constants';
import { LessonHttpContract, LessonProblem, LessonProblemFilter } from './lesson-http-contract';
import { readPageRequest } from './lesson-pagination';
import {
  PmoDashboardLessonResponse,
  PmoDashboardResponse,
  PmoDashboardSummaryResponse,
} from './lesson-response.dto';
import {
  PMO_DASHBOARD_CARDS,
  PMO_DASHBOARD_SORTS,
  PmoDashboardQuery,
} from './lesson-submissions-query.dto';
import { LessonsService } from './lessons.service';

@ApiTags('PMO Dashboard')
@ApiExtraModels(
  LocalAccessProblem,
  LessonProblem,
  PmoDashboardLessonResponse,
  PmoDashboardSummaryResponse,
  PmoDashboardResponse,
)
@Controller('pmo')
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class PmoDashboardController {
  constructor(@Inject(LessonsService) private readonly lessons: LessonsService) {}

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get PMO operational dashboard with 30-day UTC summary cards and filtered lessons' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'search', required: false, type: String, description: 'A case- and accent-insensitive title prefix, numeric ID or #ID.' })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter to lessons without a project.' })
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({ name: 'status', required: false, enum: LESSON_STATUSES })
  @ApiQuery({ name: 'card', required: false, enum: PMO_DASHBOARD_CARDS, description: 'Optional quick-filter matching one of the four summary cards.' })
  @ApiQuery({ name: 'sort', required: false, enum: PMO_DASHBOARD_SORTS, default: 'activity', description: 'Sort order for the PMO Dashboard list.' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiOkResponse({ type: PmoDashboardResponse })
  @ApiBadRequestResponse({ description: 'Invalid PMO Dashboard query parameter.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile is not a PMO moderator.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getPmoDashboard(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: PmoDashboardQuery }))
    filters: PmoDashboardQuery,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PmoDashboardResponse> {
    return this.lessons.getPmoDashboard(typeof header === 'string' ? header : undefined, filters, readPageRequest('true', cursor, limit)!);
  }
}
