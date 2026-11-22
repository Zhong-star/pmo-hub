import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ResourceAllocationAccessService } from '../src/access/resource-allocation-access.service';
import { ResourceAllocationException } from '../src/access/resource-allocation-problem';

describe('ResourceAllocationAccessService', () => {
  it('maps a PostgreSQL connection failure during access lookup to 503', async () => {
    const connectionFailure = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const dataSource = {
      isInitialized: true,
      getRepository: () => ({ findOne: async () => { throw connectionFailure; } }),
    } as unknown as DataSource;
    const service = new ResourceAllocationAccessService(dataSource, true);

    const error = await service.getAccess('local-developer').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ResourceAllocationException);
    if (!(error instanceof ResourceAllocationException)) throw error;
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(error.getStatus()).toBe(503);
  });
});
