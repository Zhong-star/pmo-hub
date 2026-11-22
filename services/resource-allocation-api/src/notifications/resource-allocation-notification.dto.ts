import { ApiProperty } from '@nestjs/swagger';
import { CursorPageInfoDto } from '../common/resource-allocation-contract.dto';

export class ResourceNotificationTargetDto {
  @ApiProperty({ type: String, enum: ['REQUEST'] })
  type!: 'REQUEST';

  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;

  @ApiProperty({ type: Boolean, description: 'Whether the current recipient can still open the request.' })
  available!: boolean;

  @ApiProperty({
    type: String,
    enum: ['REQUEST_DETAIL', 'PRESENTATION_QUEUE', 'TEAM_DECISION_QUEUE', 'ALLOCATION_DETAIL'],
    nullable: true,
    description: 'Frontend destination that is currently available to this recipient, when one exists.',
  })
  destination!: 'REQUEST_DETAIL' | 'PRESENTATION_QUEUE' | 'TEAM_DECISION_QUEUE' | 'ALLOCATION_DETAIL' | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Allocation identifier when the current recipient may open allocation detail.' })
  allocationId!: string | null;
}

export class ResourceNotificationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, maxLength: 80 })
  eventCode!: string;

  @ApiProperty({ type: String, maxLength: 200 })
  title!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;

  @ApiProperty({ type: () => ResourceNotificationTargetDto })
  target!: ResourceNotificationTargetDto;

  @ApiProperty({ type: String, description: 'Strong ETag for If-Match when marking this item as read.' })
  etag!: string;
}

export class ResourceNotificationPageDto {
  @ApiProperty({ type: () => ResourceNotificationDto, isArray: true })
  items!: ResourceNotificationDto[];

  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}

export class ResourceNotificationReadAllDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Database cutoff captured with the transaction-visible inbox snapshot.',
  })
  cutoffAt!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  markedCount!: number;
}
