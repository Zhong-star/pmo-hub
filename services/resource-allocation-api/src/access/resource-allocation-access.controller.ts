import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ResourceAccessResponseDto, ResourceAllocationProblemDto } from './access-response.dto';
import { ResourceAllocationAccessService } from './resource-allocation-access.service';
import { localProfileChallenge, localProfileHeader } from './resource-allocation-problem';

function accessProblem(status: number, description: string) {
  return ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } } },
    ...(status === 401 ? {
      headers: { 'WWW-Authenticate': { schema: { type: 'string', example: localProfileChallenge } } },
    } : {}),
  });
}

@ApiTags('Tech Resource Allocation access')
@ApiExtraModels(ResourceAllocationProblemDto)
@Controller()
export class ResourceAllocationAccessController {
  constructor(@Inject(ResourceAllocationAccessService) private readonly accessService: ResourceAllocationAccessService) {}

  @Get('access')
  @ApiOperation({ summary: 'Resolve the selected Hub profile against Tech Resource Allocation access' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceAccessResponseDto })
  @accessProblem(401, 'A local Hub profile is required.')
  @accessProblem(403, 'The profile is not active in this module; active Admin contacts are included.')
  @accessProblem(503, 'The access database or local identity mode is unavailable.')
  @accessProblem(500, 'An unexpected server error occurred.')
  async getAccess(
    @Headers(localProfileHeader) localUserId?: string,
  ): Promise<ResourceAccessResponseDto> {
    return this.accessService.getAccess(localUserId);
  }
}
