import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ResourceAccessResponseDto } from './access-response.dto';
import { ProblemResponse, ProtectedResourceProblems } from './problem-response.decorator';
import { ResourceAllocationAccessService } from './resource-allocation-access.service';
import { localProfileHeader } from './resource-allocation-problem';

@ApiTags('Tech Resource Allocation access')
@ProtectedResourceProblems()
@Controller()
export class ResourceAllocationAccessController {
  constructor(@Inject(ResourceAllocationAccessService) private readonly accessService: ResourceAllocationAccessService) {}

  @Get('access')
  @ApiOperation({ summary: 'Resolve the selected Hub profile against Tech Resource Allocation access' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceAccessResponseDto })
  @ProblemResponse(403, 'The profile is not active in this module; active Admin contacts are included.')
  @ProblemResponse(503, 'The access database or local identity mode is unavailable.')
  async getAccess(
    @Headers(localProfileHeader) localUserId?: string,
  ): Promise<ResourceAccessResponseDto> {
    return this.accessService.getAccess(localUserId);
  }
}
