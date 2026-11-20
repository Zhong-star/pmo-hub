import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
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
import { LessonHttpContract, LessonProblem, LessonProblemFilter } from './lesson-http-contract';
import {
  RankedContributorResponse,
  RankedLessonResponse,
  RankingsResponse,
} from './lesson-response.dto';
import { ContributionQueriesService } from './contribution-queries.service';

@ApiTags('Rankings')
@ApiExtraModels(
  LocalAccessProblem,
  LessonProblem,
  RankedLessonResponse,
  RankedContributorResponse,
  RankingsResponse,
)
@Controller('rankings')
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class RankingsController {
  constructor(@Inject(ContributionQueriesService) private readonly contributions: ContributionQueriesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get Top 3 Most Voted Lessons and Top 3 Contributors rankings' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: RankingsResponse })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile does not have access to Lessons Learned.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  getRankings(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
  ): Promise<RankingsResponse> {
    return this.contributions.getRankings(typeof header === 'string' ? header : undefined);
  }
}
