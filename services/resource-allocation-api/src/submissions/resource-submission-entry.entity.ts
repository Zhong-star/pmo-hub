import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'resource_submission_entries' })
export class ResourceSubmissionEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'submission_id', type: 'uuid' })
  submissionId!: string;

  @Column({ name: 'line_id', type: 'uuid' })
  lineId!: string;

  @Column({ name: 'line_number', type: 'integer' })
  lineNumber!: number;
}
