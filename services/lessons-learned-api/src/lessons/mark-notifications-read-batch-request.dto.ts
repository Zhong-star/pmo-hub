import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Max, Min } from 'class-validator';

export class MarkNotificationsReadBatchRequest {
  @ApiProperty({
    type: [Number],
    description: 'Loaded notification IDs belonging to the authenticated recipient to mark as read.',
    example: [10, 9, 8],
  })
  @IsArray({ message: 'Provide a list of notification IDs.' })
  @ArrayMinSize(1, { message: 'Provide at least one notification ID.' })
  @ArrayMaxSize(100, { message: 'Provide at most 100 notification IDs per request.' })
  @IsInt({ each: true, message: 'Each notification ID must be a positive integer.' })
  @Min(1, { each: true, message: 'Each notification ID must be a positive integer.' })
  @Max(2147483647, { each: true, message: 'Each notification ID must be a valid integer.' })
  notificationIds!: number[];
}
