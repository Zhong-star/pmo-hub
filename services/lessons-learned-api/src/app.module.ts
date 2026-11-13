import { Module, type DynamicModule } from '@nestjs/common';
import { getLessonsLearnedDatabaseUrl } from './database/database-options';
import { LessonsLearnedDatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { HomeController } from './home.controller';
import { LessonsController } from './lessons/lessons.controller';
import { LessonsService } from './lessons/lessons.service';
import { LocalAccessService } from './local-access.service';

@Module({
  controllers: [HealthController, HomeController, LessonsController],
  providers: [LocalAccessService, LessonsService],
})
export class AppModule {
  static register(databaseUrl = getLessonsLearnedDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: databaseUrl ? [LessonsLearnedDatabaseModule.forDatabaseUrl(databaseUrl)] : [],
    };
  }
}
