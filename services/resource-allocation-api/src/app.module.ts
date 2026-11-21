import { Module, type DynamicModule } from '@nestjs/common';
import { getResourceAllocationDatabaseUrl } from './database/database-options';
import { ResourceAllocationDatabaseModule } from './database/database.module';
import { ResourceAllocationAccessController } from './access/resource-allocation-access.controller';
import { ResourceAllocationAccessService } from './access/resource-allocation-access.service';
import { HealthController } from './health.controller';
import { ResourceAllocationAdministrationController } from './administration/resource-allocation-administration.controller';
import { ResourceAllocationAdministrationService } from './administration/resource-allocation-administration.service';
import { ResourceAllocationSelectionController } from './administration/resource-allocation-selection.controller';
import { ResourceAllocationSubmissionController, ResourceAllocationOperationResultController } from './submissions/resource-allocation-submission.controller';
import { ResourceAllocationSubmissionService } from './submissions/resource-allocation-submission.service';
import { ResourceAllocationSubmissionWorker } from './submissions/resource-allocation-submission.worker';
import { ResourceAllocationNotificationController } from './notifications/resource-allocation-notification.controller';
import { ResourceAllocationNotificationService } from './notifications/resource-allocation-notification.service';
import { ResourceAllocationRequestQueueController } from './requests/resource-allocation-request-queue.controller';
import { ResourceAllocationRequestQueueService } from './requests/resource-allocation-request-queue.service';
import { ResourceAllocationRequestAuditController, ResourceAllocationRequestController } from './requests/resource-allocation-request.controller';
import { ResourceAllocationRequestService } from './requests/resource-allocation-request.service';
import { ResourceAllocationApprovalController } from './approvals/resource-allocation-approval.controller';
import { ResourceAllocationApprovalService } from './approvals/resource-allocation-approval.service';

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
    ResourceAllocationApprovalController,
  ],
  providers: [
    ResourceAllocationAccessService,
    ResourceAllocationAdministrationService,
    ResourceAllocationSubmissionService,
    ResourceAllocationSubmissionWorker,
    ResourceAllocationNotificationService,
    ResourceAllocationRequestQueueService,
    ResourceAllocationRequestService,
    ResourceAllocationApprovalService,
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
