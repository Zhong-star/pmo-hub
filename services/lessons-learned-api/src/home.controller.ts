import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { LessonsLearnedHomeResponse } from './home-response.dto';
import { LocalAccessService } from './local-access.service';

interface LocalIdentityRequest {
  headers: { 'x-pmo-local-user-id'?: string | string[] };
}

@ApiTags('Lessons Learned home')
@Controller()
export class HomeController {
  constructor(@Inject(LocalAccessService) private readonly localAccess: LocalAccessService) {}

  @Get('home')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revalidate local access and return the authorized Lessons Learned Home' })
  @ApiHeader({
    name: 'x-pmo-local-user-id',
    required: true,
    description: 'Selected local Hub profile ID; the API resolves its module role.',
  })
  @ApiOkResponse({ type: LessonsLearnedHomeResponse })
  @ApiForbiddenResponse({
    description: 'The selected profile has no active Lessons Learned access.',
    schema: {
      type: 'object',
      required: ['statusCode', 'code', 'message'],
      properties: {
        statusCode: { type: 'number', example: 403 },
        code: { type: 'string', enum: ['ACCESS_DENIED'] },
        message: { type: 'string', example: 'Access denied.' },
      },
    },
  })
  @ApiInternalServerErrorResponse({
    description: 'The Lessons Learned local access configuration is invalid.',
    schema: {
      type: 'object',
      required: ['statusCode', 'code', 'message'],
      properties: {
        statusCode: { type: 'number', example: 500 },
        code: { type: 'string', enum: ['ACCESS_CONFIGURATION_ERROR'] },
        message: { type: 'string', example: 'Lessons Learned access configuration is invalid.' },
      },
    },
  })
  @ApiServiceUnavailableResponse({
    description: 'Local simulated identity is disabled for this runtime.',
    schema: {
      type: 'object',
      required: ['statusCode', 'code', 'message'],
      properties: {
        statusCode: { type: 'number', example: 503 },
        code: { type: 'string', enum: ['LOCAL_AUTH_DISABLED'] },
        message: { type: 'string', example: 'Local simulated access is not enabled for this runtime.' },
      },
    },
  })
  getHome(@Req() request: LocalIdentityRequest): LessonsLearnedHomeResponse {
    const header = request.headers['x-pmo-local-user-id'];
    const localUserId = typeof header === 'string' ? header : undefined;
    return this.localAccess.getHome(localUserId);
  }
}
