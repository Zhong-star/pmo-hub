export interface ResourceAllocationWorkerJob {
  name: string;
  runBatch(): Promise<unknown>;
}

export const RESOURCE_ALLOCATION_WORKER_INTERVAL_MS = 10_000;

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
