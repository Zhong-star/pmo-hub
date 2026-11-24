import { CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity({ name: 'resource_profile_audit_events' })
@Index('resource_profile_audit_events_order_idx', ['profileId', 'occurredAt', 'id'])
export class ResourceProfileAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'profile_id', type: 'uuid' })
  profileId!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ name: 'before_snapshot', type: 'jsonb', nullable: true })
  beforeSnapshot!: Record<string, unknown> | null;

  @Column({ name: 'after_snapshot', type: 'jsonb' })
  afterSnapshot!: Record<string, unknown>;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
