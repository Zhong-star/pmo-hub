import { Controller, Get, Header, Headers, Inject, UseFilters } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags, getSchemaPath, ApiExtraModels } from '@nestjs/swagger';
import { LessonsLearnedHomeResponse } from './home-response.dto';
import {
  LocalAccessProblem,
  LocalAccessProblemFilter,
  localProfileChallenge,
  localProfileHeader,
  localProfileScheme,
} from './local-access-problem';
import { LocalAccessService } from './local-access.service';

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
@ApiExtraModels(LocalAccessProblem)
@Controller()
@UseFilters(LocalAccessProblemFilter)
export class HomeController {
  constructor(@Inject(LocalAccessService) private readonly localAccess: LocalAccessService) {}

  @Get('home')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revalidate local access and return the authorized Lessons Learned Home' })
  @ApiSecurity(localProfileScheme)
  @ApiOkResponse({ type: LessonsLearnedHomeResponse })
  @accessProblem(401, 'A local Hub profile must be selected.')
  @accessProblem(403, 'The selected profile has no active Lessons Learned access.')
  @accessProblem(500, 'The Lessons Learned local access configuration is invalid.')
  @accessProblem(503, 'Local simulated identity is disabled for this runtime.')
  getHome(@Headers(localProfileHeader.toLowerCase()) header?: string | string[]): LessonsLearnedHomeResponse {
    return this.localAccess.getHome(typeof header === 'string' ? header : undefined);
  }
}
