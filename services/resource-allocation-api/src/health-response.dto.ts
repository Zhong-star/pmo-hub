import { ApiProperty } from '@nestjs/swagger';

export class ResourceAllocationHealthResponseDto {
  @ApiProperty({ type: String, example: 'resource-allocation-api' })
  service!: string;

  @ApiProperty({ enum: ['live', 'ready'], example: 'ready' })
  status!: 'live' | 'ready';

  @ApiProperty({ type: String, example: '0.1.0' })
  version!: string;
}
