import { describe, expect, it, vi } from 'vitest';
import {
  RESOURCE_ALLOCATION_WORKER_INTERVAL_MS,
  createResourceAllocationWorkerJobs,
  runResourceAllocationWorkerCycle,
} from '../src/workers/resource-allocation-worker-cycle';

describe('Resource Allocation worker cycle', () => {
  it('checks deadlines often enough to stay within the one-minute processing limit', () => {
    expect(RESOURCE_ALLOCATION_WORKER_INTERVAL_MS).toBe(10_000);
    expect(RESOURCE_ALLOCATION_WORKER_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it('continues to deadline jobs when a submission batch fails', async () => {
    const deadlineBatch = vi.fn(async () => 1);
    const deniedBatch = vi.fn(async () => 1);
    const proposalBatch = vi.fn(async () => 1);
    const reportFailure = vi.fn();

    const jobs = createResourceAllocationWorkerJobs({
      processSubmissions: async () => { throw new Error('database timeout'); },
      processWaitingDeadlines: deadlineBatch,
      expireDeniedRequests: deniedBatch,
      processProposalDeadlines: proposalBatch,
    });
    const failures = await runResourceAllocationWorkerCycle(jobs, reportFailure);

    expect(failures).toBe(1);
    expect(deadlineBatch).toHaveBeenCalledOnce();
    expect(deniedBatch).toHaveBeenCalledOnce();
    expect(proposalBatch).toHaveBeenCalledOnce();
    expect(jobs.map((job) => job.name)).toEqual(['submission', 'waiting deadline', 'denied response deadline', 'changed proposal deadline']);
    expect(reportFailure).toHaveBeenCalledWith('submission', expect.any(Error));
  });
});
