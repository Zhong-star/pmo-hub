import { Inject, Injectable } from '@nestjs/common';
import { ResourceAllocationService } from './resource-allocation.service';

@Injectable()
export class ResourceAllocationLifecycleWorker {
  constructor(
    @Inject(ResourceAllocationService)
    private readonly allocationService: ResourceAllocationService,
  ) {}

  processBatch(limit = 100): Promise<number> {
    return this.allocationService.processScheduledBatch(limit);
  }
}
