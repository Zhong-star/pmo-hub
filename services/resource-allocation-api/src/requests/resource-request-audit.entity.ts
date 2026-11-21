import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ResourceRequestRemovalAction = 'WITHDRAWN' | 'ADMIN_REMOVED' | 'EXPIRED';

@Entity({ name: 'resource_request_audits' })
export class ResourceRequestAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @Column({ type: 'varchar', length: 40 })
  action!: ResourceRequestRemovalAction;

  @Column({ name: 'requester_snapshot', type: 'jsonb' })
  requesterSnapshot!: Record<string, unknown>;

  @Column({ name: 'actor_snapshot', type: 'jsonb' })
  actorSnapshot!: Record<string, unknown>;

  @Column({ name: 'request_snapshot', type: 'jsonb' })
  requestSnapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 2000 })
  reason!: string;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
