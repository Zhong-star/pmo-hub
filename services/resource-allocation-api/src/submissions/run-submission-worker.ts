import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createResourceAllocationDataSourceOptions, getResourceAllocationDatabaseUrl, RESOURCE_ALLOCATION_DATABASE_URL_ENV } from '../database/database-options';
import { ResourceAllocationSubmissionWorker } from './resource-allocation-submission.worker';
import { ResourceAllocationDeadlineWorker } from '../deadlines/resource-allocation-deadline.worker';
import { ResourceAllocationProposalResponseService } from '../approvals/resource-allocation-proposal-response.service';
import { ResourceAllocationTeamDecisionService } from '../decisions/resource-allocation-team-decision.service';
import { ResourceAllocationAccessService } from '../access/resource-allocation-access.service';
import { ResourceAllocationService } from '../allocations/resource-allocation.service';
import {
  RESOURCE_ALLOCATION_WORKER_INTERVAL_MS,
  createResourceAllocationWorkerJobs,
  runResourceAllocationWorkerCycle,
} from '../workers/resource-allocation-worker-cycle';
import { ResourceAllocationWorkerOperationMonitor, safeWorkerErrorCode } from '../workers/resource-allocation-worker-health';

async function main() {
  const databaseUrl = getResourceAllocationDatabaseUrl();
  if (!databaseUrl) throw new Error(`Set ${RESOURCE_ALLOCATION_DATABASE_URL_ENV} before running the Resource Allocation worker.`);

  const dataSource = new DataSource(createResourceAllocationDataSourceOptions(databaseUrl));
  await dataSource.initialize();
  const submissionWorker = new ResourceAllocationSubmissionWorker(dataSource);
  const deadlineWorker = new ResourceAllocationDeadlineWorker(dataSource);
  const decisions = new ResourceAllocationTeamDecisionService(dataSource, true);
  const allocationService = new ResourceAllocationService(dataSource, new ResourceAllocationAccessService(dataSource, true));
  const proposalResponseService = new ResourceAllocationProposalResponseService(dataSource, true);
  const operationMonitor = new ResourceAllocationWorkerOperationMonitor(dataSource);
  const jobs = createResourceAllocationWorkerJobs({
    processSubmissions: () => submissionWorker.processBatch(),
    processWaitingDeadlines: () => deadlineWorker.processBatch(),
    expireDeniedRequests: () => decisions.expireDeniedRequests(),
    processProposalDeadlines: () => proposalResponseService.processProposalDeadlineBatch(),
    processAllocationStates: () => allocationService.processScheduledBatch(),
  });
  const once = process.argv.includes('--once');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    if (once) {
      if (await runResourceAllocationWorkerCycle(jobs, reportWorkerFailure, operationMonitor) > 0) process.exitCode = 1;
      return;
    }
    while (!stopping) {
      await runResourceAllocationWorkerCycle(jobs, reportWorkerFailure, operationMonitor);
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, RESOURCE_ALLOCATION_WORKER_INTERVAL_MS));
    }
  } finally {
    await dataSource.destroy();
  }
}

function reportWorkerFailure(jobName: string, error: unknown): void {
  process.stderr.write(`Resource Allocation ${jobName} worker cycle failed: ${safeWorkerErrorCode(error)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Resource Allocation worker could not start: ${safeWorkerErrorCode(error)}\n`);
  process.exitCode = 1;
});
