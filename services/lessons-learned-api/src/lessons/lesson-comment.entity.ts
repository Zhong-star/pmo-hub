import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'lesson_comments' })
export class LessonComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'lesson_id', type: 'integer' })
  lessonId!: number;

  @Column({ name: 'parent_comment_id', type: 'integer', nullable: true })
  parentCommentId!: number | null;

  @Column({ name: 'author_user_id', type: 'varchar', length: 128 })
  authorUserId!: string;

  @Column({ name: 'author_display_name', type: 'varchar', length: 200 })
  authorDisplayName!: string;

  @Column({ type: 'varchar', length: 2000 })
  body!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'hidden_at', type: 'timestamptz', nullable: true })
  hiddenAt!: Date | null;

  @Column({ name: 'hidden_by_user_id', type: 'varchar', length: 128, nullable: true })
  hiddenByUserId!: string | null;

  @Column({ name: 'hidden_by_display_name', type: 'varchar', length: 200, nullable: true })
  hiddenByDisplayName!: string | null;

  @Column({ name: 'hidden_reason', type: 'varchar', length: 1000, nullable: true })
  hiddenReason!: string | null;
}
