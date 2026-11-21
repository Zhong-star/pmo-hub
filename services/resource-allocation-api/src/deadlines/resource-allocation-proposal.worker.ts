import { Inject, Injectable } from '@nestjs/common';
import { ResourceAllocationApprovalService } from '../approvals/resource-allocation-approval.service';

@Injectable()
export class ResourceAllocationProposalWorker {
  constructor(
    @Inject(ResourceAllocationApprovalService)
    private readonly approvalService: ResourceAllocationApprovalService,
  ) {}

  processBatch(limit = 100): Promise<number> {
    return this.approvalService.processProposalDeadlineBatch(limit);
  }
}
