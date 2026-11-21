import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../database/database.module';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceRequest, } from '../requests/resource-request.entity';
import { ResourceRequestDecisionState } from '../submissions/submission-category';
import { removeResourceRequest } from '../requests/remove-resource-request';

const maximumBatchSize = 100;
const actorSnapshot = {
  personId: '00000000-0000-4000-8000-000000000000',
  displayName: 'Resource Allocation deadline worker',
  role: 'SYSTEM',
};
const expirationReason = 'Automatically expired after more than 21 days waiting for presentation.';

interface DueRequestTimes {
  expired: boolean;
  reminder7Days: boolean;
  reminder14Days: boolean;
  reminder7DaysPending: boolean;
  reminder14DaysPending: boolean;
}

@Injectable()
export class ResourceAllocationDeadlineWorker {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
  ) {}

  /** Processes a bounded number of due Waiting requests. Row locks make retries and parallel workers safe. */
  async processBatch(limit = maximumBatchSize): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumBatchSize) {
      throw new RangeError(`The deadline worker batch limit must be between 1 and ${maximumBatchSize}.`);
    }

    const candidates = await this.dataSource.query(`
      SELECT request.id
      FROM resource_requests AS request
      WHERE request.decision_state = $2
        AND request.removed_at IS NULL
        AND (
          request.expiration_due_at < clock_timestamp()
          OR (
            request.received_at + INTERVAL '168 hours' <= clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM resource_allocation_notifications AS notice
              WHERE notice.source_request_id = request.id AND notice.event_code = 'REQUEST_WAITING_REMINDER_7D'
            )
          )
          OR (
            request.received_at + INTERVAL '336 hours' <= clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM resource_allocation_notifications AS notice
              WHERE notice.source_request_id = request.id AND notice.event_code = 'REQUEST_WAITING_REMINDER_14D'
            )
          )
        )
      ORDER BY request.received_at ASC, request.id ASC
      LIMIT $1
    `, [limit, ResourceRequestDecisionState.WaitingForPresentation]) as Array<{ id: string }>;

    let processed = 0;
    for (const { id } of candidates) {
      if (await this.processRequest(id)) processed += 1;
    }
    return processed;
  }

  private async processRequest(id: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('request.id = :id AND request.decision_state = :waiting AND request.removed_at IS NULL', {
          id,
          waiting: ResourceRequestDecisionState.WaitingForPresentation,
        })
        .getOne();
      if (!request) return false;

      const times = await manager.query(`
        SELECT
          clock_timestamp() > $1::timestamptz AS expired,
          clock_timestamp() >= $2::timestamptz + INTERVAL '168 hours' AS "reminder7Days",
          clock_timestamp() >= $2::timestamptz + INTERVAL '336 hours' AS "reminder14Days",
          NOT EXISTS (
            SELECT 1 FROM resource_allocation_notifications AS notice
            WHERE notice.source_request_id = $3 AND notice.event_code = 'REQUEST_WAITING_REMINDER_7D'
          ) AS "reminder7DaysPending",
          NOT EXISTS (
            SELECT 1 FROM resource_allocation_notifications AS notice
            WHERE notice.source_request_id = $3 AND notice.event_code = 'REQUEST_WAITING_REMINDER_14D'
          ) AS "reminder14DaysPending"
      `, [request.expirationDueAt, request.receivedAt, request.id]) as Array<DueRequestTimes>;
      const due = times[0];

      if (due.expired) {
        await this.expire(manager, request);
        return true;
      }

      if (due.reminder7Days && due.reminder7DaysPending) {
        await this.remind(manager, request, 'REQUEST_WAITING_REMINDER_7D', 7);
      }
      if (due.reminder14Days && due.reminder14DaysPending) {
        await this.remind(manager, request, 'REQUEST_WAITING_REMINDER_14D', 14);
      }
      return (due.reminder7Days && due.reminder7DaysPending) || (due.reminder14Days && due.reminder14DaysPending);
    });
  }

  private async expire(manager: Parameters<typeof removeResourceRequest>[0], request: ResourceRequest): Promise<void> {
    const audit = await removeResourceRequest(manager, {
      request,
      action: 'EXPIRED',
      actorSnapshot,
      reason: expirationReason,
      correlationId: randomUUID(),
    });
    await this.notifyRecipients(manager, request, {
      eventCode: 'REQUEST_EXPIRED',
      title: 'Resource request expired',
      message: 'The request has expired after more than 21 days waiting for presentation and was removed from the operational queue. Its audit record is retained.',
      createdAt: audit.occurredAt,
    });
  }

  private async remind(
    manager: Parameters<typeof removeResourceRequest>[0],
    request: ResourceRequest,
    eventCode: 'REQUEST_WAITING_REMINDER_7D' | 'REQUEST_WAITING_REMINDER_14D',
    days: 7 | 14,
  ): Promise<void> {
    const timestamps = await manager.query('SELECT clock_timestamp() AS created_at') as Array<{ created_at: Date }>;
    await this.notifyRecipients(manager, request, {
      eventCode,
      title: 'Resource request waiting for presentation',
      message: `The request has been waiting for presentation for ${days} days.`,
      createdAt: timestamps[0].created_at,
    });
  }

  private async notifyRecipients(
    manager: Parameters<typeof removeResourceRequest>[0],
    request: ResourceRequest,
    notice: { eventCode: string; title: string; message: string; createdAt: Date },
  ): Promise<void> {
    const admins = await manager.getRepository(ResourcePerson).find({
      where: { role: ResourceAllocationRole.Admin, active: true },
      select: { id: true },
      order: { id: 'ASC' },
    });
    const recipients = new Set([request.requesterId, ...admins.map((admin) => admin.id)]);
    const repository = manager.getRepository(ResourceAllocationNotification);
    await repository.createQueryBuilder()
      .insert()
      .into(ResourceAllocationNotification)
      .values([...recipients].map((recipientId) => ({
        recipientId,
        sourceRequestId: request.id,
        eventCode: notice.eventCode,
        title: notice.title,
        message: notice.message,
        createdAt: notice.createdAt,
      })))
      .orIgnore()
      .execute();
  }
}
