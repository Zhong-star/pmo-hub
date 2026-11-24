import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_allocation_notifications' })
export class ResourceAllocationNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ name: 'source_request_id', type: 'uuid', nullable: true })
  sourceRequestId!: string | null;

  @Column({ name: 'source_allocation_id', type: 'uuid', nullable: true })
  sourceAllocationId!: string | null;

  @Column({ name: 'event_code', type: 'varchar', length: 80 })
  eventCode!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;
}
