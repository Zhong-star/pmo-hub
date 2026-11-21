import { Column, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';
import { ResourceAllocationRole } from './resource-allocation-role';

@Entity({ name: 'resource_people' })
export class ResourcePerson {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'local_user_id', type: 'varchar', length: 200, unique: true })
  localUserId!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 200 })
  displayName!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 40 })
  role!: ResourceAllocationRole;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'covered_group_ids', type: 'uuid', array: true, default: () => "'{}'" })
  coveredGroupIds!: string[];

  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId!: string | null;

  @VersionColumn({ default: 1 })
  version!: number;
}
