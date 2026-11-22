import { Module, type DynamicModule } from '@nestjs/common';
import { getResourceAllocationDatabaseUrl } from './database/database-options';
import { ResourceAllocationDatabaseModule } from './database/database.module';
import { ResourceAllocationAccessController } from './access/resource-allocation-access.controller';
import { ResourceAllocationAccessService } from './access/resource-allocation-access.service';
import { HealthController } from './health.controller';
import { ResourceAllocationAdministrationController } from './administration/resource-allocation-administration.controller';
import { ResourceAllocationAdministrationService } from './administration/resource-allocation-administration.service';
import { ResourceAllocationOperationResultService } from './administration/idempotency/resource-allocation-operation-result.service';
import { ResourceAllocationSelectionController } from './administration/resource-allocation-selection.controller';
import { ResourceAllocationApprovalController } from './approvals/resource-allocation-approval.controller';
import { ResourceAllocationApprovalService } from './approvals/resource-allocation-approval.service';
import { ResourceAllocationProposalResponseService } from './approvals/resource-allocation-proposal-response.service';
import { ResourceAllocationDeadlineWorker } from './deadlines/resource-allocation-deadline.worker';
import { ResourceAllocationSubmissionController, ResourceAllocationOperationResultController } from './submissions/resource-allocation-submission.controller';
import { ResourceAllocationSubmissionService } from './submissions/resource-allocation-submission.service';
import { ResourceAllocationSubmissionWorker } from './submissions/resource-allocation-submission.worker';
import { ResourceAllocationNotificationController } from './notifications/resource-allocation-notification.controller';
import { ResourceAllocationNotificationService } from './notifications/resource-allocation-notification.service';
import { ResourceAllocationController } from './allocations/resource-allocation.controller';
import { ResourceAllocationService } from './allocations/resource-allocation.service';
import { ResourceAllocationRequestQueueController } from './requests/resource-allocation-request-queue.controller';
import { ResourceAllocationRequestQueueReadService } from './requests/resource-allocation-request-queue-read.service';
import { ResourceAllocationPresentationService } from './requests/resource-allocation-presentation.service';
import { ResourceAllocationRequestRevalidationService } from './requests/resource-allocation-request-revalidation.service';
import { ResourceAllocationRequestAuditController, ResourceAllocationRequestController } from './requests/resource-allocation-request.controller';
import { ResourceAllocationRequestService } from './requests/resource-allocation-request.service';
import { ResourceAllocationDecisionController } from './decisions/resource-allocation-decision.controller';
import { ResourceAllocationTeamDecisionService } from './decisions/resource-allocation-team-decision.service';
import { ResourceAllocationRequesterResponseService } from './decisions/resource-allocation-requester-response.service';
import { ResourceAllocationExceptionResolutionService } from './decisions/resource-allocation-exception-resolution.service';
import { ResourceAllocationRequestHistoryService } from './decisions/resource-allocation-request-history.service';

@Module({
  controllers: [
    HealthController,
    ResourceAllocationAccessController,
    ResourceAllocationAdministrationController,
    ResourceAllocationSelectionController,
    ResourceAllocationSubmissionController,
    ResourceAllocationOperationResultController,
    ResourceAllocationNotificationController,
    ResourceAllocationRequestQueueController,
    ResourceAllocationRequestController,
    ResourceAllocationRequestAuditController,
    ResourceAllocationDecisionController,
    ResourceAllocationApprovalController,
    ResourceAllocationController,
  ],
  providers: [
    ResourceAllocationAccessService,
    ResourceAllocationAdministrationService,
    ResourceAllocationOperationResultService,
    ResourceAllocationSubmissionService,
    ResourceAllocationSubmissionWorker,
    ResourceAllocationNotificationService,
    ResourceAllocationRequestQueueReadService,
    ResourceAllocationPresentationService,
    ResourceAllocationRequestRevalidationService,
    ResourceAllocationRequestService,
    ResourceAllocationApprovalService,
    ResourceAllocationProposalResponseService,
    ResourceAllocationService,
    ResourceAllocationDeadlineWorker,
    ResourceAllocationTeamDecisionService,
    ResourceAllocationRequesterResponseService,
    ResourceAllocationExceptionResolutionService,
    ResourceAllocationRequestHistoryService,
  ],
})
export class AppModule {
  static register(databaseUrl = getResourceAllocationDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: [ResourceAllocationDatabaseModule.forDatabaseUrl(databaseUrl)],
    };
  }
}
