import { Module, type DynamicModule } from '@nestjs/common';
import { getLessonsLearnedDatabaseUrl } from './database/database-options';
import { LessonsLearnedDatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { HomeController } from './home.controller';
import { LessonCommentsService } from './lessons/lesson-comments.service';
import { LessonsController } from './lessons/lessons.controller';
import { PmoDashboardController } from './lessons/pmo-dashboard.controller';
import { ProfilesController } from './lessons/profiles.controller';
import { LessonsService } from './lessons/lessons.service';
import { ProjectCatalogService } from './lessons/project-catalog.service';
import { LocalAccessService } from './local-access.service';

@Module({
  controllers: [HealthController, HomeController, LessonsController, PmoDashboardController, ProfilesController],
  providers: [LocalAccessService, LessonsService, LessonCommentsService, ProjectCatalogService],
})
export class AppModule {
  static register(databaseUrl = getLessonsLearnedDatabaseUrl()): DynamicModule {
    return {
      module: AppModule,
      imports: databaseUrl ? [LessonsLearnedDatabaseModule.forDatabaseUrl(databaseUrl)] : [],
    };
  }
}
