import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';
import type { ResourcePersonClassification } from '../people/resource-person-classification';

@Entity({ name: 'resource_allocations' })
export class ResourceAllocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_request_id', type: 'uuid', unique: true, nullable: true })
  sourceRequestId!: string | null;

  @Column({ name: 'origin', type: 'varchar', length: 16, default: 'REQUEST' })
  origin!: 'REQUEST' | 'SELF' | 'DIRECT';

  @Column({ type: 'varchar', length: 40, nullable: true })
  category!: string | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'classification', type: 'varchar', length: 20, nullable: true })
  classification!: ResourcePersonClassification | null;

  @Column({ name: 'created_by_person_id', type: 'uuid', nullable: true })
  createdByPersonId!: string | null;

  @Column({ name: 'person_id', type: 'uuid' })
  personId!: string;

  @Column({ name: 'person_snapshot', type: 'jsonb' })
  personSnapshot!: Record<string, unknown>;

  @Column({ name: 'group_id', type: 'uuid' })
  groupId!: string;

  @Column({ name: 'group_snapshot', type: 'jsonb' })
  groupSnapshot!: Record<string, unknown>;

  @Column({ name: 'initiative_id', type: 'uuid', nullable: true })
  initiativeId!: string | null;

  @Column({ name: 'initiative_snapshot', type: 'jsonb', nullable: true })
  initiativeSnapshot!: Record<string, unknown> | null;

  @Column({ name: 'resource_profile_id', type: 'uuid', nullable: true })
  resourceProfileId!: string | null;

  @Column({ name: 'resource_profile_snapshot', type: 'jsonb', nullable: true })
  resourceProfileSnapshot!: Record<string, unknown> | null;

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
