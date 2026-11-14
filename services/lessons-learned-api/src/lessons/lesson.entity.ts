import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { LessonStatus, LessonType } from './lesson-domain.constants';

@Entity({ name: 'lessons' })
export class Lesson {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id!: number;

  @Column({ type: 'varchar', length: 150 })
  title!: string;

  @Column({ name: 'author_id', type: 'varchar', length: 128 })
  authorId!: string;

  @Column({ name: 'updated_by', type: 'varchar', length: 128 })
  updatedBy!: string;

  @Column({ type: 'varchar', length: 32, default: 'Open' })
  status!: LessonStatus;

  @Column({ type: 'integer', default: 1 })
  version!: number;

  @Column({ name: 'project_id', type: 'varchar', length: 128, nullable: true })
  projectId!: string | null;

  @Column({ name: 'project_name', type: 'varchar', length: 200, nullable: true })
  projectName!: string | null;

  @Column({ name: 'project_category', type: 'varchar', length: 32, nullable: true })
  projectCategory!: 'Technology' | 'Business' | 'Infrastructure' | 'Data' | null;

  @Column({ name: 'project_phase', type: 'varchar', length: 32, nullable: true })
  projectPhase!: 'Initiation' | 'Planning' | 'Execution' | 'Closure' | 'Not Applicable' | null;

  @Column({ name: 'situation_observed', type: 'varchar', length: 4000, nullable: true })
  situationObserved!: string | null;

  @Column({ name: 'root_cause', type: 'varchar', length: 4000, nullable: true })
  rootCause!: string | null;

  @Column({ name: 'lesson_type', type: 'varchar', length: 32, nullable: true })
  lessonType!: LessonType | null;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  impact!: string | null;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  recommendation!: string | null;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  applicability!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
