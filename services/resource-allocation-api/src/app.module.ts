import { Module, type DynamicModule } from '@nestjs/common';
import { getResourceAllocationDatabaseUrl } from './database/database-options';
import { ResourceAllocationDatabaseModule } from './database/database.module';
import { ResourceAllocationAccessController } from './access/resource-allocation-access.controller';
import { ResourceAllocationAccessService } from './access/resource-allocation-access.service';
import { HealthController } from './health.controller';
import { ResourceAllocationAdministrationController } from './administration/resource-allocation-administration.controller';
import { ResourceAllocationAdministrationService } from './administration/resource-allocation-administration.service';
import { ResourceAllocationSelectionController } from './administration/resource-allocation-selection.controller';

@Module({
  controllers: [
    HealthController,
    ResourceAllocationAccessController,
    ResourceAllocationAdministrationController,
    ResourceAllocationSelectionController,
  ],
  providers: [ResourceAllocationAccessService, ResourceAllocationAdministrationService],
})
export class AppModule {
  static register(databaseUrl = getResourceAllocationDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: [ResourceAllocationDatabaseModule.forDatabaseUrl(databaseUrl)],
    };
  }
}
