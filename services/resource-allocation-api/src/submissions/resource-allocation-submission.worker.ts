import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../database/database.module';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { markInitiativeUsedForRequest } from '../initiatives/mark-initiative-used';
import { ResourceSubmission } from './resource-submission.entity';
import { ResourceSubmissionLine } from './resource-submission-line.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceRequestCategory, ResourceRequestDecisionState, ResourceSubmissionLineStatus } from './submission-category';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';

interface ClaimedLine {
  id: string;
  claimToken: string;
}

interface SubmittedConditions {
  initiativeId: string;
  category: ResourceRequestCategory;
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  comment?: string;
}

@Injectable()
export class ResourceAllocationSubmissionWorker {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
  ) {}

  /** Claims and resolves at most twenty independent lines. Repeat calls are safe across workers. */
  async processBatch(limit = 20): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('The worker batch limit must be between 1 and 100.');
    let processed = 0;
    while (processed < limit) {
      const claim = await this.claimOne();
      if (!claim) break;
      await this.processClaim(claim);
      processed += 1;
    }
    return processed;
  }

  private async claimOne(): Promise<ClaimedLine | undefined> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`
        WITH abandoned AS (
          SELECT id
          FROM resource_submission_lines
          WHERE status = 'PROCESSING' AND claimed_at < clock_timestamp() - INTERVAL '1 minute'
          ORDER BY claimed_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 20
        )
        UPDATE resource_submission_lines AS line
        SET status = 'RECEIVED', claim_token = NULL, claimed_at = NULL
        FROM abandoned
        WHERE line.id = abandoned.id
      `);
      const token = randomUUID();
      const rows = await manager.query(`
        WITH ready AS (
          SELECT id
          FROM resource_submission_lines
          WHERE status = 'RECEIVED'
          ORDER BY received_at ASC, submission_id ASC, line_number ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE resource_submission_lines AS line
        SET status = 'PROCESSING', claim_token = $1::uuid, claimed_at = clock_timestamp()
        FROM ready
        WHERE line.id = ready.id
        RETURNING line.id
      `, [token]) as Array<{ id: string }>;
      return rows.length === 0 ? undefined : { id: rows[0].id, claimToken: token };
    });
  }

  private async processClaim(claim: ClaimedLine): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await lockResourceAllocationAdministrationWrites(manager);
      const line = await manager.getRepository(ResourceSubmissionLine).findOne({
        where: {
          id: claim.id,
          status: ResourceSubmissionLineStatus.Processing,
          claimToken: claim.claimToken,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!line) return;

      const submission = await manager.getRepository(ResourceSubmission).findOne({ where: { id: line.submissionId } });
      if (!submission) throw new Error('A submission line references a missing submission.');
      try {
        const request = await this.createRequest(manager, submission, line);
        const completionTimes = await manager.query('SELECT clock_timestamp() AS completed_at') as Array<{ completed_at: Date }>;
        line.status = ResourceSubmissionLineStatus.Succeeded;
        line.requestId = request.id;
        line.requestOutcome = { decisionState: request.decisionState, requestedConditions: request.requestedConditions };
        line.problem = null;
        line.completedAt = completionTimes[0].completed_at;
        line.claimToken = null;
        line.claimedAt = null;
        await manager.getRepository(ResourceSubmissionLine).save(line);
      } catch (error) {
        if (!this.isDefinitiveBusinessFailure(error)) throw error;
        const completionTimes = await manager.query('SELECT clock_timestamp() AS completed_at') as Array<{ completed_at: Date }>;
        line.status = ResourceSubmissionLineStatus.Failed;
        line.requestId = null;
        line.requestOutcome = null;
        line.problem = { code: error.code, message: error.detail };
        line.completedAt = completionTimes[0].completed_at;
        line.claimToken = null;
        line.claimedAt = null;
        await manager.getRepository(ResourceSubmissionLine).save(line);
      }
    });
  }

  private async createRequest(manager: EntityManager, submission: ResourceSubmission, line: ResourceSubmissionLine) {
    const conditions = line.submittedConditions as unknown as SubmittedConditions;
    const requester = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .setLock('pessimistic_write')
      .where('person.id = :id AND person.active = TRUE', { id: line.requesterId })
      .getOne();
    if (!requester) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The requester no longer has active Tech Resource Allocation access.');
    }

    const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
      .setLock('pessimistic_write')
      .where('group.id = :id AND group.active = TRUE', { id: conditions.groupId })
      .getOne();
    const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
      .setLock('pessimistic_write')
      .where('profile.id = :id AND profile.active = TRUE', { id: conditions.resourceProfileId })
      .getOne();
    const initiative = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .setLock('pessimistic_write')
      .where('initiative.id = :id AND initiative.active = TRUE', { id: conditions.initiativeId })
      .getOne();
    if (!group || !profile || profile.groupId !== group.id || !initiative || submission.category !== conditions.category) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The selected ITDM, group, or resource profile is no longer active and eligible.');
    }

    const expired = await manager.query(
      "SELECT $1::timestamptz + INTERVAL '21 days' < clock_timestamp() AS expired",
      [line.receivedAt],
    ) as Array<{ expired: boolean }>;
    if (expired[0].expired) {
      throw new ResourceAllocationException('SUBMISSION_EXPIRED', 'Submission expired', 422, 'This request line was not processed within 21 days of durable receipt. Review its dates and submit a corrected attempt.');
    }

    this.validateDates(conditions, await this.localToday(manager));
    const weeklyHours = normalizeRequestedWeeklyHours(conditions.weeklyHours);
    await markInitiativeUsedForRequest(manager, initiative.id);

    const requestedConditions = {
      initiativeId: initiative.id,
      initiativeCode: initiative.code,
      initiativeName: initiative.name,
      category: submission.category,
      groupId: group.id,
      groupName: group.name,
      resourceProfileId: profile.id,
      resourceProfileName: profile.name,
      startDate: conditions.startDate,
      endDate: conditions.endDate,
      weeklyHours,
      ...(conditions.comment === undefined ? {} : { comment: conditions.comment }),
    };
    const receivedAt = line.receivedAt;
    const expirationDueAt = new Date(receivedAt.getTime() + 21 * 24 * 60 * 60 * 1000);
    const eventTimes = await manager.query('SELECT clock_timestamp() AS occurred_at') as Array<{ occurred_at: Date }>;
    const occurredAt = eventTimes[0].occurred_at;
    const requestRepository = manager.getRepository(ResourceRequest);
    const request = await requestRepository.save(requestRepository.create({
      submissionLineId: line.id,
      requesterId: requester.id,
      requesterSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
      requestedConditions,
      decisionState: ResourceRequestDecisionState.WaitingForPresentation,
      receivedAt,
      stageEnteredAt: receivedAt,
      expirationDueAt,
      version: 1,
    }));

    const actorSnapshot = { personId: requester.id, displayName: requester.displayName, role: requester.role };
    const historyRepository = manager.getRepository(ResourceRequestHistory);
    await historyRepository.insert({
      requestId: request.id,
      actorSnapshot,
      action: 'SUBMITTED',
      afterSnapshot: { requestId: request.id, decisionState: request.decisionState, requestedConditions },
      correlationId: submission.correlationId,
      occurredAt,
    });

    const administrators = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .where('person.active = TRUE AND person.role = :role AND person.id <> :requesterId', {
        role: ResourceAllocationRole.Admin,
        requesterId: requester.id,
      })
      .orderBy('person.id', 'ASC')
      .getMany();
    if (administrators.length > 0) {
      await manager.getRepository(ResourceAllocationNotification).insert(administrators.map((administrator) => ({
        recipientId: administrator.id,
        sourceRequestId: request.id,
        eventCode: 'REQUEST_SUBMITTED',
        title: 'New resource request',
        message: 'A resource request is waiting for presentation.',
        createdAt: occurredAt,
      })));
    }
    return request;
  }

  private async localToday(manager: EntityManager): Promise<string> {
    const rows = await manager.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    return rows[0].today;
  }

  private validateDates(conditions: SubmittedConditions, today: string): { startDate: string; endDate: string } {
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!validDate(conditions.startDate) || !validDate(conditions.endDate) || conditions.startDate < today || conditions.endDate < conditions.startDate) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The request dates must be valid, start today or later, and end on or after the start date. Review the dates and submit a corrected attempt.');
    }
    return { startDate: conditions.startDate, endDate: conditions.endDate };
  }

  private isDefinitiveBusinessFailure(error: unknown): error is ResourceAllocationException {
    return error instanceof ResourceAllocationException && [400, 403, 404, 409, 422].includes(error.getStatus());
  }
}
