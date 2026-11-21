import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { isDatabaseUnavailable } from '../database/database-errors';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceSubmission } from './resource-submission.entity';
import { ResourceSubmissionLine } from './resource-submission-line.entity';
import { ResourceSubmissionEntry } from './resource-submission-entry.entity';
import { CreateResourceSubmissionRequestDto } from './submission-request.dto';
import { ResourceSubmissionLineStatus } from './submission-category';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';

const submissionOperation = 'submission.create';
const defaultPageSize = 50;
const maximumPageSize = 100;
const cursorVersion = 1;

interface CursorValue {
  version: number;
  kind: 'submissions' | 'submission-lines';
  receivedAt?: string;
  id: string;
  lineNumber?: number;
  submissionId?: string;
}

interface PageQuery {
  limit?: string;
  cursor?: string;
}

@Injectable()
export class ResourceAllocationSubmissionService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async receive(
    localUserId: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CreateResourceSubmissionRequestDto,
  ) {
    this.ensureDatabaseAvailable();
    const correlation = this.requireCorrelationId(correlationId);
    const attemptKeys = input.lines.map((line) => line.attemptKey.toLowerCase());
    if (new Set(attemptKeys).size !== attemptKeys.length) {
      throw this.validationError('Each line in an envelope must have a distinct attemptKey.');
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actor = await this.requireActiveRequester(manager, localUserId);
        const operation = await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: submissionOperation,
          key: idempotencyKey,
          payload: this.normalizeEnvelope(input),
        }, async () => {
          const receiptTimes = await manager.query('SELECT clock_timestamp() AS received_at') as Array<{ received_at: Date }>;
          const submissions = manager.getRepository(ResourceSubmission);
          const submission = await submissions.save(submissions.create({
            requesterId: actor.id,
            category: input.category,
            lineCount: input.lines.length,
            correlationId: correlation,
            receivedAt: receiptTimes[0].received_at,
          }));
          const lines = manager.getRepository(ResourceSubmissionLine);
          const entries = manager.getRepository(ResourceSubmissionEntry);
          for (const [lineNumber, inputLine] of input.lines.entries()) {
            const submittedConditions = {
              initiativeId: input.initiativeId.toLowerCase(),
              category: input.category,
              attemptKey: inputLine.attemptKey.toLowerCase(),
              groupId: inputLine.groupId.toLowerCase(),
              resourceProfileId: inputLine.resourceProfileId.toLowerCase(),
              startDate: inputLine.startDate,
              endDate: inputLine.endDate,
              weeklyHours: inputLine.weeklyHours,
              ...(inputLine.comment === undefined ? {} : { comment: inputLine.comment }),
            };
            const attemptPayloadHash = this.hashPayload(submittedConditions);
            let line = await lines.findOne({
              where: { requesterId: actor.id, attemptKey: inputLine.attemptKey.toLowerCase() },
            });
            if (line) {
              if (line.attemptPayloadHash !== attemptPayloadHash) {
                throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Attempt key already used', 409, 'This attemptKey was already used with different line content.');
              }
            } else {
              line = await lines.save(lines.create({
                submissionId: submission.id,
                requesterId: actor.id,
                attemptKey: inputLine.attemptKey.toLowerCase(),
                attemptPayloadHash,
                lineNumber,
                submittedConditions,
                status: ResourceSubmissionLineStatus.Received,
                requestId: null,
                problem: null,
                requestOutcome: null,
                claimToken: null,
                claimedAt: null,
                receivedAt: submission.receivedAt,
                completedAt: null,
              }));
            }
            await entries.insert({ submissionId: submission.id, lineId: line.id, lineNumber });
          }
          return this.toSubmissionResponse(submission, await this.countsForSubmission(manager, submission.id));
        });
        return operation;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Attempt key already used', 409, 'An attemptKey was already used for another submission.');
      }
      throw this.translateDatabaseError(error);
    }
  }

  async list(localUserId: string | undefined, query: PageQuery) {
    const actor = await this.requireActiveRequesterOutsideTransaction(localUserId);
    const page = this.parsePage(query, 'submissions');
    const repository = this.dataSource.getRepository(ResourceSubmission);
    const builder = repository.createQueryBuilder('submission')
      .where('submission.requester_id = :requesterId', { requesterId: actor.id })
      .orderBy('submission.received_at', 'DESC')
      .addOrderBy('submission.id', 'DESC');
    if (page.after) {
      builder.andWhere('(submission.received_at, submission.id) < (:receivedAt, :id)', {
        receivedAt: page.after.receivedAt,
        id: page.after.id,
      });
    }
    const found = await builder.take(page.limit + 1).getMany();
    const hasNext = found.length > page.limit;
    const submissions = found.slice(0, page.limit);
    const items = await Promise.all(submissions.map(async (submission) => this.toSubmissionResponse(
      submission,
      await this.countsForSubmission(this.dataSource.manager, submission.id),
    )));
    return {
      items,
      page: {
        nextCursor: hasNext && submissions.length > 0
          ? this.encodeCursor({
            version: cursorVersion,
            kind: 'submissions',
            receivedAt: submissions[submissions.length - 1].receivedAt.toISOString(),
            id: submissions[submissions.length - 1].id,
          })
          : null,
        limit: page.limit,
      },
    };
  }

  async get(localUserId: string | undefined, id: string) {
    const actor = await this.requireActiveRequesterOutsideTransaction(localUserId);
    const submission = await this.dataSource.getRepository(ResourceSubmission).findOne({
      where: { id, requesterId: actor.id },
    });
    if (!submission) throw this.notFound('Submission');
    return this.toSubmissionResponse(submission, await this.countsForSubmission(this.dataSource.manager, submission.id));
  }

  async listLines(localUserId: string | undefined, submissionId: string, query: PageQuery) {
    const actor = await this.requireActiveRequesterOutsideTransaction(localUserId);
    const submission = await this.dataSource.getRepository(ResourceSubmission).findOne({
      where: { id: submissionId, requesterId: actor.id },
      select: { id: true },
    });
    if (!submission) throw this.notFound('Submission');
    const page = this.parsePage(query, 'submission-lines', submission.id);
    const parameters: unknown[] = [submission.id, actor.id];
    let cursorFilter = '';
    if (page.after) {
      if (page.after.submissionId !== submission.id || page.after.lineNumber === undefined) {
        throw this.validationError('cursor is invalid for this submission.');
      }
      parameters.push(page.after.lineNumber, page.after.id);
      cursorFilter = 'AND (entry.line_number, line.id) > ($3, $4::uuid)';
    }
    parameters.push(page.limit + 1);
    const found = await this.dataSource.query(`
      SELECT line.*, entry.line_number AS entry_line_number
      FROM resource_submission_entries AS entry
      INNER JOIN resource_submission_lines AS line ON line.id = entry.line_id
      WHERE entry.submission_id = $1 AND line.requester_id = $2 ${cursorFilter}
      ORDER BY entry.line_number ASC, line.id ASC
      LIMIT $${parameters.length}
    `, parameters) as Array<Record<string, unknown>>;
    const hasNext = found.length > page.limit;
    const lines = found.slice(0, page.limit).map((row) => ({
      lineNumber: Number(row.entry_line_number),
      response: this.toLineResponseFromDatabaseRow(row),
      id: String(row.id),
    }));
    return {
      items: lines.map(({ response }) => response),
      page: {
        nextCursor: hasNext && lines.length > 0
          ? this.encodeCursor({
            version: cursorVersion,
            kind: 'submission-lines',
            submissionId: submission.id,
            lineNumber: lines[lines.length - 1].lineNumber,
            id: lines[lines.length - 1].id,
          })
          : null,
        limit: page.limit,
      },
    };
  }

  async getOperationResult(localUserId: string | undefined, attemptKey: string, operation: string | undefined) {
    const actor = await this.requireActiveRequesterOutsideTransaction(localUserId);
    if (operation !== submissionOperation) {
      throw this.validationError('operation must identify the original submission.create operation.');
    }
    const line = await this.dataSource.getRepository(ResourceSubmissionLine).findOne({
      where: { requesterId: actor.id, attemptKey: attemptKey.toLowerCase() },
    });
    if (!line) throw this.notFound('Operation result');
    return this.toLineResponse(line);
  }

  private async requireActiveRequesterOutsideTransaction(localUserId: string | undefined) {
    this.ensureDatabaseAvailable();
    try {
      return await this.requireActiveRequester(this.dataSource.manager, localUserId);
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async requireActiveRequester(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    if (process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED === 'false' || process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true') {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before submitting requests.');
    }
    const repository = manager.getRepository(ResourcePerson);
    const requester = manager.queryRunner?.isTransactionActive
      ? await repository.createQueryBuilder('person')
        .setLock('pessimistic_write')
        .where('person.localUserId = :localUserId AND person.active = TRUE', { localUserId })
        .getOne()
      : await repository.findOne({ where: { localUserId, active: true } });
    if (!requester) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    }
    return requester;
  }

  private async countsForSubmission(manager: EntityManager, submissionId: string) {
    const rows = await manager.query(
      `SELECT line.status, count(*)::integer AS count
       FROM resource_submission_entries AS entry
       INNER JOIN resource_submission_lines AS line ON line.id = entry.line_id
       WHERE entry.submission_id = $1
       GROUP BY line.status`,
      [submissionId],
    ) as Array<{ status: string; count: number }>;
    const counts = { received: 0, processing: 0, succeeded: 0, failed: 0 };
    for (const row of rows) {
      const key = row.status.toLowerCase() as keyof typeof counts;
      counts[key] = Number(row.count);
    }
    return counts;
  }

  private toSubmissionResponse(submission: ResourceSubmission, counts: { RECEIVED?: number; PROCESSING?: number; SUCCEEDED?: number; FAILED?: number } | { received: number; processing: number; succeeded: number; failed: number }) {
    return {
      id: submission.id,
      receivedAt: submission.receivedAt.toISOString(),
      lineCount: submission.lineCount,
      counts: {
        received: 'received' in counts ? counts.received : counts.RECEIVED ?? 0,
        processing: 'processing' in counts ? counts.processing : counts.PROCESSING ?? 0,
        succeeded: 'succeeded' in counts ? counts.succeeded : counts.SUCCEEDED ?? 0,
        failed: 'failed' in counts ? counts.failed : counts.FAILED ?? 0,
      },
    };
  }

  private toLineResponse(line: ResourceSubmissionLine) {
    return {
      id: line.id,
      attemptKey: line.attemptKey,
      submittedConditions: line.submittedConditions,
      status: line.status,
      ...(line.requestId ? { requestId: line.requestId } : {}),
      ...(line.problem ? { problem: line.problem } : {}),
      receivedAt: line.receivedAt.toISOString(),
      ...(line.completedAt ? { completedAt: line.completedAt.toISOString() } : {}),
      ...(line.requestOutcome ? { requestOutcome: line.requestOutcome } : {}),
    };
  }

  private toLineResponseFromDatabaseRow(line: Record<string, unknown>) {
    const receivedAt = line.received_at instanceof Date ? line.received_at : new Date(String(line.received_at));
    const completedAt = line.completed_at === null || line.completed_at === undefined
      ? undefined
      : line.completed_at instanceof Date ? line.completed_at : new Date(String(line.completed_at));
    return {
      id: String(line.id),
      attemptKey: String(line.attempt_key),
      submittedConditions: line.submitted_conditions as Record<string, unknown>,
      status: String(line.status),
      ...(line.request_id ? { requestId: String(line.request_id) } : {}),
      ...(line.problem ? { problem: line.problem as { code: string; message: string; detail?: string; title?: string } } : {}),
      receivedAt: receivedAt.toISOString(),
      ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
      ...(line.request_outcome ? { requestOutcome: line.request_outcome as Record<string, unknown> } : {}),
    };
  }

  private normalizeEnvelope(input: CreateResourceSubmissionRequestDto) {
    return {
      initiativeId: input.initiativeId.toLowerCase(),
      category: input.category,
      lines: input.lines.map((line) => ({
        attemptKey: line.attemptKey.toLowerCase(),
        groupId: line.groupId.toLowerCase(),
        resourceProfileId: line.resourceProfileId.toLowerCase(),
        startDate: line.startDate,
        endDate: line.endDate,
        weeklyHours: line.weeklyHours,
        ...(line.comment === undefined ? {} : { comment: line.comment }),
      })),
    };
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
  }

  private parsePage(query: PageQuery, kind: CursorValue['kind'], submissionId?: string) {
    const limit = query.limit === undefined ? defaultPageSize : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) {
      throw this.validationError('limit must be an integer between 1 and 100.');
    }
    const after = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor, kind, submissionId);
    return { limit, after };
  }

  private decodeCursor(value: string, kind: CursorValue['kind'], submissionId?: string): CursorValue {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorValue;
      if (!decoded || decoded.version !== cursorVersion || decoded.kind !== kind ||
        !/^[0-9a-f-]{36}$/i.test(decoded.id) ||
        (kind === 'submissions' && (!decoded.receivedAt || Number.isNaN(Date.parse(decoded.receivedAt)))) ||
        (kind === 'submission-lines' && (!Number.isInteger(decoded.lineNumber) || decoded.submissionId !== submissionId))) {
        throw new Error('Invalid cursor fields.');
      }
      return decoded;
    } catch {
      throw this.validationError('cursor is invalid for this collection.');
    }
  }

  private encodeCursor(value: CursorValue): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private requireCorrelationId(value: string | undefined): string {
    if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
      throw this.validationError('A valid X-Correlation-ID is required.');
    }
    return value.toLowerCase();
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private isUniqueViolation(error: unknown): boolean {
    let cause = error;
    for (let depth = 0; depth < 4 && cause; depth += 1) {
      if (typeof cause !== 'object') return false;
      const value = cause as { code?: unknown; driverError?: unknown; cause?: unknown };
      if (value.code === '23505') return true;
      cause = value.driverError ?? value.cause;
    }
    return false;
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is unavailable or not prepared.', undefined, error);
    }
    throw new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
