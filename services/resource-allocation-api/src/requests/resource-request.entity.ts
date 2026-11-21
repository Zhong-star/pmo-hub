import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'resource_requests' })
export class ResourceRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'submission_line_id', type: 'uuid', unique: true })
  submissionLineId!: string;

  @Column({ name: 'requester_id', type: 'uuid' })
  requesterId!: string;

  @Column({ name: 'requester_snapshot', type: 'jsonb' })
  requesterSnapshot!: Record<string, unknown>;

  @Column({ name: 'requested_conditions', type: 'jsonb' })
  requestedConditions!: Record<string, unknown>;

  @Column({ name: 'approved_conditions', type: 'jsonb', nullable: true })
  approvedConditions!: Record<string, unknown> | null;

  @Column({ name: 'decision_state', type: 'varchar', length: 40 })
  decisionState!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'stage_entered_at', type: 'timestamptz' })
  stageEnteredAt!: Date;

  @Column({ name: 'expiration_due_at', type: 'timestamptz' })
  expirationDueAt!: Date;

  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @VersionColumn({ default: 1 })
  version!: number;
}
