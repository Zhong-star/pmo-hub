import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, ValidateIf } from 'class-validator';
import { IsTrimmedLength } from '../administration/trimmed-length.validator';

export class CreateInitiativeRequestDto {
  @ApiProperty({ maxLength: 100, example: 'ITDM-041' })
  @IsString()
  @IsTrimmedLength(1, 100)
  code!: string;

  @ApiProperty({ maxLength: 200, example: 'Planning portal' })
  @IsString()
  @IsTrimmedLength(1, 200)
  name!: string;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class UpdateInitiativeRequestDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'ITDM-041' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1, 100)
  code?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'Planning portal' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class ResourceInitiativeResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, maxLength: 100 })
  code!: string;

  @ApiProperty({ type: String, maxLength: 200 })
  name!: string;

  @ApiProperty({ type: Boolean })
  active!: boolean;

  @ApiProperty({ type: Number })
  version!: number;
}

export class ResourceInitiativeCollectionResponseDto {
  @ApiProperty({ type: () => ResourceInitiativeResponseDto, isArray: true })
  items!: ResourceInitiativeResponseDto[];

  @ApiProperty({ type: Object, example: { nextCursor: null, limit: 50 } })
  page!: { nextCursor: string | null; limit: number };
}
