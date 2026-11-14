import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'lesson_history' })
@Index('lesson_history_lesson_id_id_idx', ['lessonId', 'id'])
export class LessonHistory {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id!: number;

  @Column({ name: 'lesson_id', type: 'integer' })
  lessonId!: number;

  @Column({ name: 'actor_id', type: 'varchar', length: 128 })
  actorId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 32 })
  eventType!: 'Created' | 'Submitted' | 'Cancelled';

  @Column({ name: 'previous_status', type: 'varchar', length: 32, nullable: true })
  previousStatus!: 'Open' | 'PMOEvaluation' | 'Approved' | 'Closed' | 'Archived' | null;

  @Column({ name: 'new_status', type: 'varchar', length: 32 })
  newStatus!: 'Open' | 'PMOEvaluation' | 'Approved' | 'Closed' | 'Archived';

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
