import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createResourceAllocationDataSourceOptions, getResourceAllocationDatabaseUrl, RESOURCE_ALLOCATION_DATABASE_URL_ENV } from '../database/database-options';
import { ResourceAllocationSubmissionWorker } from './resource-allocation-submission.worker';
import { ResourceAllocationDeadlineWorker } from '../deadlines/resource-allocation-deadline.worker';
import { ResourceAllocationProposalWorker } from '../deadlines/resource-allocation-proposal.worker';
import { ResourceAllocationApprovalService } from '../approvals/resource-allocation-approval.service';
import { ResourceAllocationDecisionService } from '../decisions/resource-allocation-decision.service';
import {
  RESOURCE_ALLOCATION_WORKER_INTERVAL_MS,
  createResourceAllocationWorkerJobs,
  runResourceAllocationWorkerCycle,
} from '../workers/resource-allocation-worker-cycle';

async function main() {
  const databaseUrl = getResourceAllocationDatabaseUrl();
  if (!databaseUrl) throw new Error(`Set ${RESOURCE_ALLOCATION_DATABASE_URL_ENV} before running the Resource Allocation worker.`);

  const dataSource = new DataSource(createResourceAllocationDataSourceOptions(databaseUrl));
  await dataSource.initialize();
  const submissionWorker = new ResourceAllocationSubmissionWorker(dataSource);
  const deadlineWorker = new ResourceAllocationDeadlineWorker(dataSource);
  const decisions = new ResourceAllocationDecisionService(dataSource, true);
  const proposalWorker = new ResourceAllocationProposalWorker(new ResourceAllocationApprovalService(dataSource, true));
  const jobs = createResourceAllocationWorkerJobs({
    processSubmissions: () => submissionWorker.processBatch(),
    processWaitingDeadlines: () => deadlineWorker.processBatch(),
    expireDeniedRequests: () => decisions.expireDeniedRequests(),
    processProposalDeadlines: () => proposalWorker.processBatch(),
  });
  const once = process.argv.includes('--once');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    if (once) {
      if (await runResourceAllocationWorkerCycle(jobs, reportWorkerFailure) > 0) process.exitCode = 1;
      return;
    }
    while (!stopping) {
      await runResourceAllocationWorkerCycle(jobs, reportWorkerFailure);
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, RESOURCE_ALLOCATION_WORKER_INTERVAL_MS));
    }
  } finally {
    await dataSource.destroy();
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function reportWorkerFailure(jobName: string, error: unknown): void {
  process.stderr.write(`Resource Allocation ${jobName} worker cycle failed: ${safeErrorName(error)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Resource Allocation worker could not start: ${safeErrorName(error)}\n`);
  process.exitCode = 1;
});
