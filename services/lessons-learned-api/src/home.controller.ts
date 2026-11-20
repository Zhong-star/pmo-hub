import { Controller, Get, Header, Headers, Inject, UseFilters, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags, getSchemaPath, ApiExtraModels } from '@nestjs/swagger';
import { LessonsLearnedHomeResponse } from './home-response.dto';
import { LessonHttpContract, LessonProblem, LessonProblemFilter } from './lessons/lesson-http-contract';
import {
  LocalAccessProblem,
  LocalAccessProblemFilter,
  localProfileChallenge,
  localProfileHeader,
  localProfileScheme,
} from './local-access-problem';
import { HomeService } from './home.service';

function accessProblem(status: number, description: string) {
  return ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(LocalAccessProblem) } } },
    ...(status === 401 ? {
      headers: { 'WWW-Authenticate': { schema: { type: 'string', example: localProfileChallenge } } },
    } : {}),
  });
}

@ApiTags('Lessons Learned home')
@ApiExtraModels(LocalAccessProblem, LessonProblem)
@Controller()
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class HomeController {
  constructor(@Inject(HomeService) private readonly homeService: HomeService) {}

  @Get('home')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revalidate local access and return the authorized Lessons Learned Home' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: LessonsLearnedHomeResponse })
  @accessProblem(401, 'A local Hub profile must be selected.')
  @accessProblem(403, 'The selected profile has no active Lessons Learned access.')
  @accessProblem(500, 'The Lessons Learned local access configuration is invalid.')
  @accessProblem(503, 'Local simulated identity is disabled for this runtime.')
  getHome(@Headers(localProfileHeader.toLowerCase()) header?: string | string[]): Promise<LessonsLearnedHomeResponse> {
    return this.homeService.getHome(typeof header === 'string' ? header : undefined);
  }
}
