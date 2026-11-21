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

export interface ResourceAllocationWorkerObserver {
  onStarted(jobName: string): Promise<void> | void;
  onSucceeded(jobName: string, processedCount: number): Promise<void> | void;
  onFailed(jobName: string, error: unknown): Promise<void> | void;
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
  observer?: ResourceAllocationWorkerObserver,
): Promise<number> {
  let failures = 0;
  for (const job of jobs) {
    if (observer) await notifyObserver(() => observer.onStarted(job.name), job.name, reportFailure);
    try {
      const processed = await job.runBatch();
      await notifyObserver(() => observer?.onSucceeded(job.name, typeof processed === 'number' ? processed : 0), job.name, reportFailure);
    } catch (error) {
      failures += 1;
      reportFailure(job.name, error);
      if (observer) await notifyObserver(() => observer.onFailed(job.name, error), job.name, reportFailure);
    }
  }
  return failures;
}

async function notifyObserver(
  notify: () => Promise<void> | void,
  jobName: string,
  reportFailure: (jobName: string, error: unknown) => void,
): Promise<void> {
  try {
    await notify();
  } catch (error) {
    reportFailure(`${jobName} telemetry`, error);
  }
}
