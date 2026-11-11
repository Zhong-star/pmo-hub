import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthResponse } from './health-response.dto';

@ApiTags('Lessons Learned health')
@Controller()
export class HealthController {
  @Get('health')
  @ApiOperation({ summary: 'Check Lessons Learned API availability' })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
