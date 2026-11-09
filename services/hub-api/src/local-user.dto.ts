import { ApiProperty } from '@nestjs/swagger';

export class LocalUserDto {
  @ApiProperty({ example: 'local-developer' })
  id!: string;

  @ApiProperty({ example: 'Local Developer' })
  displayName!: string;
}
