import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ResourceAllocationProblemDto } from '../access/access-response.dto';
import { localProfileHeader } from '../access/resource-allocation-problem';
import { ResourceNotificationDto, ResourceNotificationPageDto, ResourceNotificationReadAllDto } from './resource-allocation-notification.dto';
import { ResourceAllocationNotificationService } from './resource-allocation-notification.service';

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

function notificationProblem(status: number, description: string) {
  return ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } } },
    ...(status === 401 ? { headers: {
      'WWW-Authenticate': { schema: { type: 'string', example: 'LocalProfile realm="Tech Resource Allocation"' } },
    } } : {}),
  });
}

@ApiTags('Tech Resource Allocation notifications')
@Controller()
export class ResourceAllocationNotificationController {
  constructor(
    @Inject(ResourceAllocationNotificationService)
    private readonly notificationService: ResourceAllocationNotificationService,
  ) {}

  @Get('notifications')
  @ApiOperation({ summary: 'List the current user’s notifications, newest first' })
  @ApiSecurity('localProfile')
  @ApiOkResponse({ type: ResourceNotificationPageDto })
  @ApiQuery({ name: 'read', required: false, type: Boolean, description: 'Filter by read state.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, maximum 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor for the same read filter.' })
  @notificationProblem(400, 'A filter, limit, or cursor is invalid.')
  @notificationProblem(401, 'An active local profile is required.')
  @notificationProblem(403, 'The profile is not active in this module.')
  @notificationProblem(503, 'The Resource Allocation database is unavailable.')
  @notificationProblem(500, 'An unexpected persistence error occurred.')
  list(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Query('read') read?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notificationService.list(localUserId, { read, limit, cursor });
  }

  @Post('notifications/:id/readings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one of the current user’s notifications as read' })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong ETag returned with the current notification.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID identifying this mark-read attempt.' })
  @ApiOkResponse({ type: ResourceNotificationDto, headers: { ETag: { schema: { type: 'string' } } } })
  @ApiNotFoundResponse({ description: 'The notification does not exist for this user.', content: {
    'application/problem+json': { schema: { $ref: getSchemaPath(ResourceAllocationProblemDto) } },
  } })
  @notificationProblem(400, 'If-Match or Idempotency-Key is missing or invalid.')
  @notificationProblem(401, 'An active local profile is required.')
  @notificationProblem(403, 'The profile is not active in this module.')
  @notificationProblem(409, 'The idempotency key was reused with different content.')
  @notificationProblem(412, 'The notification ETag is stale.')
  @notificationProblem(503, 'The Resource Allocation database is unavailable.')
  @notificationProblem(500, 'An unexpected persistence error occurred.')
  async markOne(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Param('id', new ParseUUIDPipe()) notificationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: ResponseWithHeaders,
  ) {
    const notification = await this.notificationService.markOne(localUserId, notificationId, ifMatch, idempotencyKey);
    response.setHeader('ETag', this.notificationService.etag(notification));
    return notification;
  }

  @Post('notification-readings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all notifications through the server confirmation cutoff as read',
    description: 'cutoffAt is captured by the same PostgreSQL statement that marks notifications visible in its transaction snapshot. A concurrent notice committed afterward remains unread, even if its createdAt precedes cutoffAt.',
  })
  @ApiSecurity('localProfile')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID identifying this whole-inbox read attempt.' })
  @ApiOkResponse({
    type: ResourceNotificationReadAllDto,
    description: 'Returns the original cutoff and marked count for an idempotent replay.',
  })
  @notificationProblem(400, 'The idempotency key is missing or invalid.')
  @notificationProblem(401, 'An active local profile is required.')
  @notificationProblem(403, 'The profile is not active in this module.')
  @notificationProblem(409, 'The idempotency key was reused with different content.')
  @notificationProblem(503, 'The Resource Allocation database is unavailable.')
  @notificationProblem(500, 'An unexpected persistence error occurred.')
  markAll(
    @Headers(localProfileHeader) localUserId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.notificationService.markAll(localUserId, idempotencyKey);
  }
}
