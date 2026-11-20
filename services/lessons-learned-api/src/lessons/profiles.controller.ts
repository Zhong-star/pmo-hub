import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
  UseFilters,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
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
import { LESSON_TYPES } from './lesson-domain.constants';
import { LessonHttpContract, LessonProblem, LessonProblemFilter } from './lesson-http-contract';
import { readPageRequest } from './lesson-pagination';
import {
  ContributorProfileResponse,
  ProfileSearchPage,
  LessonLibraryResponse,
  ProfileSummaryResponse,
} from './lesson-response.dto';
import {
  CONTRIBUTOR_PROFILE_SORTS,
  ContributorProfileQuery,
  ProfileSearchQuery,
} from './lesson-submissions-query.dto';
import { LessonsService } from './lessons.service';

@ApiTags('Profiles')
@ApiExtraModels(
  LocalAccessProblem,
  LessonProblem,
  ProfileSummaryResponse,
  ProfileSearchPage,
  ContributorProfileResponse,
  LessonLibraryResponse,
)
@Controller('profiles')
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class ProfilesController {
  constructor(@Inject(LessonsService) private readonly lessons: LessonsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search authorized module profiles with public contribution aggregates' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Case- and accent-insensitive name filter for authorized module profiles.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'paged', required: false, enum: ['true'], description: 'Opt in to the cursor response envelope.' })
  @ApiOkResponse({ schema: { oneOf: [
    { type: 'array', items: { $ref: getSchemaPath(ProfileSummaryResponse) } },
    { $ref: getSchemaPath(ProfileSearchPage) },
  ] } })
  @ApiBadRequestResponse({ description: 'Invalid profile search query parameter.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile does not have access to Lessons Learned.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  searchProfiles(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: ProfileSearchQuery }))
    filters: ProfileSearchQuery,
    @Query('paged') paged?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ProfileSearchPage | ProfileSummaryResponse[]> {
    return this.lessons.searchProfiles(typeof header === 'string' ? header : undefined, filters, readPageRequest(paged, cursor, limit));
  }

  @Get(':userId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get contributor profile with public aggregates and role-scoped visible lessons' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'userId', type: String, description: 'Authorized module user ID.' })
  @ApiQuery({ name: 'projectId', required: false, type: String, description: 'Project snapshot ID.' })
  @ApiQuery({ name: 'withoutProject', required: false, type: Boolean, description: 'Filter to lessons without a project.' })
  @ApiQuery({ name: 'lessonType', required: false, enum: LESSON_TYPES })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: CONTRIBUTOR_PROFILE_SORTS,
    default: 'recent',
    description: 'Sort order for visible lessons in the Contributor Profile.',
  })
  @ApiOkResponse({ type: ContributorProfileResponse })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiBadRequestResponse({ description: 'Invalid contributor profile query parameter.' })
  @ApiNotFoundResponse({ description: 'Contributor profile not found.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile does not have access to Lessons Learned.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getContributorProfile(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('userId') userId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true, expectedType: ContributorProfileQuery }))
    filters: ContributorProfileQuery,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ContributorProfileResponse> {
    return this.lessons.getContributorProfile(
      typeof header === 'string' ? header : undefined,
      userId,
      filters,
      readPageRequest('true', cursor, limit)!,
    );
  }
}
