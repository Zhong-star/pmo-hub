import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_request_history' })
export class ResourceRequestHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @Column({ name: 'actor_snapshot', type: 'jsonb' })
  actorSnapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ name: 'after_snapshot', type: 'jsonb' })
  afterSnapshot!: Record<string, unknown>;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
