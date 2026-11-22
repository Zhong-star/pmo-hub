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

  it('records each operation independently with safe success and failure callbacks', async () => {
    const observer = {
      onStarted: vi.fn(async () => undefined),
      onSucceeded: vi.fn(async () => undefined),
      onFailed: vi.fn(async () => undefined),
    };
    const jobs = [
      { name: 'submission', runBatch: async () => 3 },
      { name: 'waiting deadline', runBatch: async () => { throw new Error('database password must never be reported'); } },
      { name: 'denied response deadline', runBatch: async () => 1 },
    ];

    const failures = await runResourceAllocationWorkerCycle(jobs, vi.fn(), observer);

    expect(failures).toBe(1);
    expect(observer.onStarted.mock.calls).toEqual([['submission'], ['waiting deadline'], ['denied response deadline']]);
    expect(observer.onSucceeded.mock.calls).toEqual([['submission', 3], ['denied response deadline', 1]]);
    expect(observer.onFailed.mock.calls).toEqual([['waiting deadline', expect.any(Error)]]);
  });

  it('schedules proposal decisions and allocation state changes without replacing existing jobs', async () => {
    const proposalBatch = vi.fn(async () => 1);
    const allocationBatch = vi.fn(async () => 1);
    const jobs = createResourceAllocationWorkerJobs({
      processSubmissions: async () => 1,
      processWaitingDeadlines: async () => 1,
      expireDeniedRequests: async () => 1,
      processProposalDeadlines: proposalBatch,
      processAllocationStates: allocationBatch,
    });

    await runResourceAllocationWorkerCycle(jobs, vi.fn());

    expect(jobs.map((job) => job.name)).toEqual([
      'submission',
      'waiting deadline',
      'denied response deadline',
      'changed proposal deadline',
      'allocation lifecycle',
    ]);
    expect(proposalBatch).toHaveBeenCalledOnce();
    expect(allocationBatch).toHaveBeenCalledOnce();
  });
});
