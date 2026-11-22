import { Inject, Injectable, type DynamicModule, type OnModuleDestroy, type OnModuleInit, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createResourceAllocationDataSourceOptions } from './database-options';

export const RESOURCE_ALLOCATION_DATA_SOURCE = Symbol('RESOURCE_ALLOCATION_DATA_SOURCE');
export const RESOURCE_ALLOCATION_DATABASE_CONFIGURED = Symbol('RESOURCE_ALLOCATION_DATABASE_CONFIGURED');

@Injectable()
class DatabaseConnectionLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly configured: boolean,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configured) await this.dataSource.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}

@Module({})
export class ResourceAllocationDatabaseModule {
  static forDatabaseUrl(databaseUrl?: string): DynamicModule {
    return {
      module: ResourceAllocationDatabaseModule,
      providers: [
        {
          provide: RESOURCE_ALLOCATION_DATA_SOURCE,
          useFactory: () => new DataSource(createResourceAllocationDataSourceOptions(databaseUrl)),
        },
        { provide: RESOURCE_ALLOCATION_DATABASE_CONFIGURED, useValue: Boolean(databaseUrl) },
        DatabaseConnectionLifecycle,
      ],
      exports: [RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED],
    };
  }
}
