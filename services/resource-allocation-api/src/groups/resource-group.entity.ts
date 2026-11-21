import { Column, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'resource_groups' })
export class ResourceGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'supervisor_id', type: 'uuid', nullable: true })
  supervisorId!: string | null;

  @Column({ name: 'manager_id', type: 'uuid', nullable: true })
  managerId!: string | null;

  @VersionColumn({ default: 1 })
  version!: number;
}
