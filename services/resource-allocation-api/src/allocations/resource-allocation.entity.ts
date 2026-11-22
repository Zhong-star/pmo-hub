import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'resource_allocations' })
export class ResourceAllocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_request_id', type: 'uuid', unique: true })
  sourceRequestId!: string;

  @Column({ name: 'person_id', type: 'uuid' })
  personId!: string;

  @Column({ name: 'person_snapshot', type: 'jsonb' })
  personSnapshot!: Record<string, unknown>;

  @Column({ name: 'group_id', type: 'uuid' })
  groupId!: string;

  @Column({ name: 'group_snapshot', type: 'jsonb' })
  groupSnapshot!: Record<string, unknown>;

  @Column({ name: 'initiative_id', type: 'uuid' })
  initiativeId!: string;

  @Column({ name: 'initiative_snapshot', type: 'jsonb' })
  initiativeSnapshot!: Record<string, unknown>;

  @Column({ name: 'resource_profile_id', type: 'uuid' })
  resourceProfileId!: string;

  @Column({ name: 'resource_profile_snapshot', type: 'jsonb' })
  resourceProfileSnapshot!: Record<string, unknown>;

  @Column({ name: 'approved_start_date', type: 'date' })
  approvedStartDate!: string;

  @Column({ name: 'approved_end_date', type: 'date' })
  approvedEndDate!: string;

  @Column({ name: 'effective_start_date', type: 'date' })
  effectiveStartDate!: string;

  @Column({ name: 'effective_end_date', type: 'date' })
  effectiveEndDate!: string;

  @Column({ name: 'weekly_hours', type: 'numeric', precision: 3, scale: 1 })
  weeklyHours!: string;

  @Column({ type: 'varchar', length: 40 })
  state!: string;

  @Column({ name: 'state_entered_at', type: 'timestamptz' })
  stateEnteredAt!: Date;

  @Column({ name: 'approved_at', type: 'timestamptz' })
  approvedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @VersionColumn({ default: 1 })
  version!: number;
}
