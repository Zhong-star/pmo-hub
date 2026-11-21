export interface ResourceAllocationWorkerJob {
  name: string;
  runBatch(): Promise<unknown>;
}

export interface ResourceAllocationWorkerActions {
  processSubmissions(): Promise<unknown>;
  processWaitingDeadlines(): Promise<unknown>;
  expireDeniedRequests(): Promise<unknown>;
  processProposalDeadlines(): Promise<unknown>;
  processAllocationStates?(): Promise<unknown>;
}

export const RESOURCE_ALLOCATION_WORKER_INTERVAL_MS = 10_000;

export function createResourceAllocationWorkerJobs(actions: ResourceAllocationWorkerActions): ResourceAllocationWorkerJob[] {
  const jobs: ResourceAllocationWorkerJob[] = [
    { name: 'submission', runBatch: actions.processSubmissions },
    { name: 'waiting deadline', runBatch: actions.processWaitingDeadlines },
    { name: 'denied response deadline', runBatch: actions.expireDeniedRequests },
    { name: 'changed proposal deadline', runBatch: actions.processProposalDeadlines },
  ];
  if (actions.processAllocationStates) {
    jobs.push({ name: 'allocation lifecycle', runBatch: actions.processAllocationStates });
  }
  return jobs;
}

/** Runs each durable job independently so one failing subsystem does not starve the remaining work. */
export async function runResourceAllocationWorkerCycle(
  jobs: readonly ResourceAllocationWorkerJob[],
  reportFailure: (jobName: string, error: unknown) => void,
): Promise<number> {
  let failures = 0;
  for (const job of jobs) {
    try {
      await job.runBatch();
    } catch (error) {
      failures += 1;
      reportFailure(job.name, error);
    }
  }
  return failures;
}
