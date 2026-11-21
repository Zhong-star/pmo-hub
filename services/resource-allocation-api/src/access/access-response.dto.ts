import { ApiProperty } from '@nestjs/swagger';
import { ResourceAllocationRole } from '../people/resource-allocation-role';

export class ResourcePersonAccessDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'local-developer' })
  localUserId!: string;

  @ApiProperty({ type: String, example: 'Local Developer' })
  displayName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  groupId!: string | null;

  @ApiProperty({ type: String, enum: Object.values(ResourceAllocationRole) })
  role!: ResourceAllocationRole;

  @ApiProperty({ type: [String], format: 'uuid', example: [] })
  coveredGroupIds!: string[];
}

export class ResourceAccessResponseDto {
  @ApiProperty({ type: ResourcePersonAccessDto })
  person!: ResourcePersonAccessDto;
}

export class AdministratorContactDto {
  @ApiProperty({ type: String, example: 'Allocation Admin' })
  displayName!: string;

  @ApiProperty({ type: String, example: 'admin@example.test' })
  email!: string;
}

export class ResourceAllocationProblemDto {
  @ApiProperty({ type: String, example: 'https://pmo-hub.example/problems/access-denied' })
  type!: string;

  @ApiProperty({ type: String, example: 'Access denied' })
  title!: string;

  @ApiProperty({ type: Number, example: 403 })
  status!: number;

  @ApiProperty({ type: String, example: 'You do not have active Tech Resource Allocation access. Contact an active Admin.' })
  detail!: string;

  @ApiProperty({ type: String, example: '/api/resource-allocation/v1/access' })
  instance!: string;

  @ApiProperty({ type: String, example: 'ACCESS_DENIED' })
  code!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;

  @ApiProperty({ type: [AdministratorContactDto], required: false })
  administrators?: AdministratorContactDto[];
}
