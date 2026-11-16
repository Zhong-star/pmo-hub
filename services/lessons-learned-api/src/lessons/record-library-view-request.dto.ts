import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RecordLibraryViewRequest {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stable idempotency key for one Library opening.' })
  @IsUUID()
  openingId!: string;
}
