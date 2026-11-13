import { Module, type DynamicModule } from '@nestjs/common';
import { getLessonsLearnedDatabaseUrl } from './database/database-options';
import { LessonsLearnedDatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class AppModule {
  static register(databaseUrl = getLessonsLearnedDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: databaseUrl ? [LessonsLearnedDatabaseModule.forDatabaseUrl(databaseUrl)] : [],
    };
  }
}
