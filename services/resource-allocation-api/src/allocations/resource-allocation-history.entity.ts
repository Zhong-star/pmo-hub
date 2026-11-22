import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_allocation_history' })
@Index('resource_allocation_history_order_idx', ['allocationId', 'occurredAt', 'id'])
export class ResourceAllocationHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'allocation_id', type: 'uuid' })
  allocationId!: string;

  @Column({ name: 'actor_snapshot', type: 'jsonb' })
  actorSnapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'before_snapshot', type: 'jsonb' })
  beforeSnapshot!: Record<string, unknown>;

  @Column({ name: 'after_snapshot', type: 'jsonb' })
  afterSnapshot!: Record<string, unknown>;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
