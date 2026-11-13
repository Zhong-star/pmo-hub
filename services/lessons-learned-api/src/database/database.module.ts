import { Inject, Injectable, type DynamicModule, type OnModuleDestroy, type OnModuleInit, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createLessonsLearnedDataSourceOptions } from './database-options';

export const LESSONS_LEARNED_DATA_SOURCE = Symbol('LESSONS_LEARNED_DATA_SOURCE');

@Injectable()
class DatabaseConnectionLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(LESSONS_LEARNED_DATA_SOURCE)
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.dataSource.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}

@Module({})
export class LessonsLearnedDatabaseModule {
  static forDatabaseUrl(databaseUrl: string): DynamicModule {
    return {
      module: LessonsLearnedDatabaseModule,
      providers: [
        {
          provide: LESSONS_LEARNED_DATA_SOURCE,
          useFactory: () => new DataSource(createLessonsLearnedDataSourceOptions(databaseUrl)),
        },
        DatabaseConnectionLifecycle,
      ],
      exports: [LESSONS_LEARNED_DATA_SOURCE],
    };
  }
}
