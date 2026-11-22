import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ResourceAllocationProblemDto } from './access/access-response.dto';
import { ResourceAllocationAccessService } from './access/resource-allocation-access.service';
import { ResourceAllocationHealthResponseDto } from './health-response.dto';

@ApiTags('Tech Resource Allocation health')
@ApiExtraModels(ResourceAllocationProblemDto)
@Controller('health')
export class HealthController {
  constructor(@Inject(ResourceAllocationAccessService) private readonly accessService: ResourceAllocationAccessService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check that the API process is running' })
  @ApiOkResponse({ type: ResourceAllocationHealthResponseDto })
  getLive(): ResourceAllocationHealthResponseDto {
    return { service: 'resource-allocation-api', status: 'live', version: '0.1.0' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check that required Resource Allocation dependencies are usable' })
  @ApiOkResponse({ type: ResourceAllocationHealthResponseDto })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable.',
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } } },
  })
  async getReady(): Promise<ResourceAllocationHealthResponseDto> {
    await this.accessService.checkReadiness();
    return { service: 'resource-allocation-api', status: 'ready', version: '0.1.0' };
  }

  @Get('startup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check that required initialization and migrations are complete' })
  @ApiOkResponse({ type: ResourceAllocationHealthResponseDto })
  @ApiResponse({
    status: 503,
    description: 'Startup dependencies or database migrations are incomplete.',
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } } },
  })
  async getStartup(): Promise<ResourceAllocationHealthResponseDto> {
    await this.accessService.checkStartup();
    return { service: 'resource-allocation-api', status: 'ready', version: '0.1.0' };
  }
}
