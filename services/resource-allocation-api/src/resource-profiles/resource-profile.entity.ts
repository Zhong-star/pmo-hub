import { Column, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'resource_profiles' })
export class ResourceProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'group_id', type: 'uuid' })
  groupId!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @VersionColumn({ default: 1 })
  version!: number;
}
