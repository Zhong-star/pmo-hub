import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseFilters,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
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
  LessonNotificationItemResponse,
  LessonNotificationPageMetadataResponse,
  LessonNotificationPageResponse,
  MarkNotificationReadResponse,
  MarkNotificationsReadBatchResponse,
} from './lesson-notification-response.dto';
import { LessonNotificationsService } from './lesson-notifications.service';
import { MarkNotificationsReadBatchRequest } from './mark-notifications-read-batch-request.dto';
import { ParsePositivePostgresIntegerPipe } from './parse-positive-postgres-integer.pipe';

@ApiTags('Notifications')
@ApiExtraModels(
  LocalAccessProblem,
  LessonProblem,
  LessonNotificationItemResponse,
  LessonNotificationPageMetadataResponse,
  LessonNotificationPageResponse,
  MarkNotificationReadResponse,
  MarkNotificationsReadBatchRequest,
  MarkNotificationsReadBatchResponse,
)
@Controller('notifications')
@UseFilters(LocalAccessProblemFilter, LessonProblemFilter)
@UseInterceptors(LessonHttpContract)
export class LessonNotificationsController {
  constructor(
    @Inject(LessonNotificationsService) private readonly notifications: LessonNotificationsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List newest-first notifications for the authenticated recipient with unread count' })
  @ApiSecurity(localProfileScheme)
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor for Load more pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size between 1 and 100 (default 20).' })
  @ApiOkResponse({ type: LessonNotificationPageResponse })
  @ApiBadRequestResponse({ description: 'Invalid notification query parameter.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiResponse({ status: 403, description: 'The selected profile does not have access to Lessons Learned.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  listNotifications(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonNotificationPageResponse> {
    return this.notifications.listNotifications(
      typeof header === 'string' ? header : undefined,
      { cursor, limit },
    );
  }

  @Post('read-batch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Mark a specific batch of loaded notifications as read for the authenticated recipient' })
  @ApiSecurity(localProfileScheme)
  @ApiBody({ type: MarkNotificationsReadBatchRequest })
  @ApiOkResponse({ type: MarkNotificationsReadBatchResponse })
  @ApiBadRequestResponse({ description: 'Invalid notification IDs list.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiForbiddenResponse({ description: 'One or more notifications belong to another recipient.' })
  @ApiNotFoundResponse({ description: 'One or more notifications were not found.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  markBatchAsRead(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: MarkNotificationsReadBatchRequest }))
    body: MarkNotificationsReadBatchRequest,
  ): Promise<MarkNotificationsReadBatchResponse> {
    return this.notifications.markBatchAsRead(
      typeof header === 'string' ? header : undefined,
      body,
    );
  }

  @Post(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Mark a single notification as read for the authenticated recipient' })
  @ApiSecurity(localProfileScheme)
  @ApiParam({ name: 'id', type: Number, description: 'Notification ID.' })
  @ApiOkResponse({ type: MarkNotificationReadResponse })
  @ApiBadRequestResponse({ description: 'Invalid notification ID.' })
  @ApiResponse({ status: 401, description: 'A local Hub profile must be selected.' })
  @ApiForbiddenResponse({ description: 'The notification belongs to another recipient.' })
  @ApiNotFoundResponse({ description: 'Notification not found.' })
  @ApiResponse({ status: 503, description: 'Lessons Learned persistence is unavailable.' })
  markAsRead(
    @Headers(localProfileHeader.toLowerCase()) header: string | string[] | undefined,
    @Param('id', ParsePositivePostgresIntegerPipe) notificationId: number,
  ): Promise<MarkNotificationReadResponse> {
    return this.notifications.markAsRead(
      typeof header === 'string' ? header : undefined,
      notificationId,
    );
  }
}
