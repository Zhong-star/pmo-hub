import { describe, expect, it, vi } from 'vitest';
import {
  RESOURCE_ALLOCATION_WORKER_INTERVAL_MS,
  runResourceAllocationWorkerCycle,
} from '../src/workers/resource-allocation-worker-cycle';

describe('Resource Allocation worker cycle', () => {
  it('checks deadlines often enough to stay within the one-minute processing limit', () => {
    expect(RESOURCE_ALLOCATION_WORKER_INTERVAL_MS).toBe(10_000);
    expect(RESOURCE_ALLOCATION_WORKER_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it('continues to deadline jobs when a submission batch fails', async () => {
    const deadlineBatch = vi.fn(async () => 1);
    const reportFailure = vi.fn();

    const failures = await runResourceAllocationWorkerCycle([
      { name: 'submissions', runBatch: async () => { throw new Error('database timeout'); } },
      { name: 'waiting deadlines', runBatch: deadlineBatch },
    ], reportFailure);

    expect(failures).toBe(1);
    expect(deadlineBatch).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith('submissions', expect.any(Error));
  });
});
