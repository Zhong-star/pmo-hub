import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsEnum, IsString, IsUUID, ValidateIf } from 'class-validator';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { IsTrimmedLength } from './trimmed-length.validator';
import { CursorPageInfoDto } from '../common/resource-allocation-contract.dto';

export class CreateResourcePersonRequestDto {
  @ApiProperty({ type: String, maxLength: 200 })
  @IsString()
  @IsTrimmedLength(1, 200)
  localUserId!: string;

  @ApiProperty({ type: String, maxLength: 200 })
  @IsString()
  @IsTrimmedLength(1, 200)
  displayName!: string;

  @ApiProperty({ type: String, maxLength: 320 })
  @IsEmail()
  @IsTrimmedLength(1, 320)
  email!: string;

  @ApiProperty({ enum: ResourceAllocationRole })
  @IsEnum(ResourceAllocationRole)
  role!: ResourceAllocationRole;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  groupId?: string | null;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class UpdateResourcePersonRequestDto {
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1, 200)
  localUserId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1, 200)
  displayName?: string;

  @ApiPropertyOptional({ type: String, maxLength: 320 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEmail()
  @IsTrimmedLength(1, 320)
  email?: string;

  @ApiPropertyOptional({ enum: ResourceAllocationRole })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(ResourceAllocationRole)
  role?: ResourceAllocationRole;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  groupId?: string | null;

  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class CreateResourceGroupRequestDto {
  @ApiProperty({ type: String })
  @IsString()
  @IsTrimmedLength(1)
  name!: string;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  supervisorId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  managerId?: string | null;
}

export class UpdateResourceGroupRequestDto {
  @ApiPropertyOptional({ type: String })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1)
  name?: string;

  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  supervisorId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  managerId?: string | null;
}

export class CreateResourceProfileRequestDto {
  @ApiProperty({ type: String })
  @IsString()
  @IsTrimmedLength(1)
  name!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  groupId!: string;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class UpdateResourceProfileRequestDto {
  @ApiPropertyOptional({ type: String })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsTrimmedLength(1)
  name?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class AdminPageResponseDto {
  @ApiProperty({ type: () => CursorPageInfoDto })
  page!: CursorPageInfoDto;
}

export class ResourcePersonResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) localUserId!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ type: String, format: 'email' }) email!: string;
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ enum: ResourceAllocationRole }) role!: ResourceAllocationRole;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) groupId!: string | null;
  @ApiProperty({ type: [String], items: { type: 'string', format: 'uuid' } }) coveredGroupIds!: string[];
  @ApiProperty({ type: Number }) version!: number;
}

export class ResourceGroupResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) supervisorId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) managerId!: string | null;
  @ApiProperty({ type: Number }) version!: number;
}

export class ResourceProfileResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) groupId!: string;
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ type: Number }) version!: number;
}

export class ResourcePersonCollectionResponseDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourcePersonResponseDto, isArray: true }) items!: ResourcePersonResponseDto[];
}

export class ResourceGroupCollectionResponseDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourceGroupResponseDto, isArray: true }) items!: ResourceGroupResponseDto[];
}

export class ResourceProfileCollectionResponseDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourceProfileResponseDto, isArray: true }) items!: ResourceProfileResponseDto[];
}

export class ResourcePersonSelectionDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) groupId!: string | null;
}

export class ResourceGroupSelectionDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
}

export class ResourceProfileSelectionDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) groupId!: string;
}

export class ResourceInitiativeSelectionDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) name!: string;
}

export class ResourcePersonSelectionCollectionDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourcePersonSelectionDto, isArray: true }) items!: ResourcePersonSelectionDto[];
}

export class ResourceGroupSelectionCollectionDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourceGroupSelectionDto, isArray: true }) items!: ResourceGroupSelectionDto[];
}

export class ResourceProfileSelectionCollectionDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourceProfileSelectionDto, isArray: true }) items!: ResourceProfileSelectionDto[];
}

export class ResourceInitiativeSelectionCollectionDto extends AdminPageResponseDto {
  @ApiProperty({ type: () => ResourceInitiativeSelectionDto, isArray: true }) items!: ResourceInitiativeSelectionDto[];
}
