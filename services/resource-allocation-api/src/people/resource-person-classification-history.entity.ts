import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ResourcePersonClassification } from './resource-person-classification';

@Entity({ name: 'resource_person_classification_history' })
export class ResourcePersonClassificationHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint', unique: true })
  sequence!: string;

  @Column({ name: 'person_id', type: 'uuid' })
  personId!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ name: 'actor_snapshot', type: 'jsonb' })
  actorSnapshot!: { personId: string; displayName: string; role: string };

  @Column({ name: 'previous_classification', type: 'varchar', length: 20, nullable: true })
  previousClassification!: ResourcePersonClassification | null;

  @Column({ name: 'next_classification', type: 'varchar', length: 20, nullable: true })
  nextClassification!: ResourcePersonClassification | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
