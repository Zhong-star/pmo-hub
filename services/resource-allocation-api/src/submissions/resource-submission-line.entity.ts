import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ResourceSubmissionLineStatus } from './submission-category';

@Entity({ name: 'resource_submission_lines' })
export class ResourceSubmissionLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'submission_id', type: 'uuid' })
  submissionId!: string;

  @Column({ name: 'requester_id', type: 'uuid' })
  requesterId!: string;

  @Column({ name: 'attempt_key', type: 'uuid' })
  attemptKey!: string;

  @Column({ name: 'attempt_payload_hash', type: 'char', length: 64 })
  attemptPayloadHash!: string;

  @Column({ name: 'line_number', type: 'integer' })
  lineNumber!: number;

  @Column({ name: 'submitted_conditions', type: 'jsonb' })
  submittedConditions!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: ResourceSubmissionLineStatus.Received })
  status!: ResourceSubmissionLineStatus;

  @Column({ name: 'request_id', type: 'uuid', nullable: true })
  requestId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  problem!: { code: string; message: string; detail?: string; title?: string } | null;

  @Column({ name: 'request_outcome', type: 'jsonb', nullable: true })
  requestOutcome!: Record<string, unknown> | null;

  @Column({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  @Column({ name: 'processing_attempts', type: 'integer', default: 0 })
  processingAttempts!: number;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
