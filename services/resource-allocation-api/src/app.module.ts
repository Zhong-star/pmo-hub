import { Module, type DynamicModule } from '@nestjs/common';
import { getResourceAllocationDatabaseUrl } from './database/database-options';
import { ResourceAllocationDatabaseModule } from './database/database.module';
import { ResourceAllocationAccessController } from './access/resource-allocation-access.controller';
import { ResourceAllocationAccessService } from './access/resource-allocation-access.service';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController, ResourceAllocationAccessController],
  providers: [ResourceAllocationAccessService],
})
export class AppModule {
  static register(databaseUrl = getResourceAllocationDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: [ResourceAllocationDatabaseModule.forDatabaseUrl(databaseUrl)],
    };
  }
}
