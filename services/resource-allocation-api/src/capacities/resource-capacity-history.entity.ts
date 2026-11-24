import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_capacity_history' })
@Index('resource_capacity_history_order_idx', ['capacityId', 'occurredAt', 'id'])
export class ResourceCapacityHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'capacity_id', type: 'uuid' })
  capacityId!: string;

  @Column({ type: 'varchar', length: 20 })
  action!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ name: 'actor_snapshot', type: 'jsonb' })
  actorSnapshot!: Record<string, unknown>;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'before_snapshot', type: 'jsonb', nullable: true })
  beforeSnapshot!: Record<string, unknown> | null;

  @Column({ name: 'after_snapshot', type: 'jsonb', nullable: true })
  afterSnapshot!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
