import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_allocation_operation_receipts' })
@Index(
  'resource_allocation_operation_receipts_actor_operation_key_uq',
  ['actorId', 'operation', 'key'],
  { unique: true },
)
export class ResourceAllocationOperationReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ type: 'varchar', length: 200 })
  operation!: string;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  key!: string;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Column({ name: 'response_body', type: 'jsonb' })
  responseBody!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
