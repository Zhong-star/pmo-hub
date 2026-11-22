import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAccessResponseDto, ResourcePersonAccessDto } from './access-response.dto';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from './resource-allocation-problem';

@Injectable()
export class ResourceAllocationAccessService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async getAccess(localUserId: string | undefined): Promise<ResourceAccessResponseDto> {
    if (!this.isLocalSimulationEnabled()) {
      throw new ResourceAllocationException(
        'LOCAL_AUTH_DISABLED', 'Local access disabled', 503,
        'Local simulated access is not enabled for this runtime.',
      );
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException(
        'AUTHENTICATION_REQUIRED', 'Local profile required', 401,
        'Select a local Hub profile before opening Tech Resource Allocation.',
      );
    }
    this.ensureDatabaseAvailable();

    try {
      const person = await this.dataSource.getRepository(ResourcePerson).findOne({
        where: { localUserId, active: true },
      });
      if (person) return { person: this.toAccessPerson(person) };

      const administrators = await this.dataSource.getRepository(ResourcePerson).find({
        where: { role: ResourceAllocationRole.Admin, active: true },
        select: { id: true, displayName: true, email: true },
        order: { displayName: 'ASC', id: 'ASC' },
      });
      throw new ResourceAllocationException(
        'ACCESS_DENIED', 'Access denied', 403,
        'You do not have active Tech Resource Allocation access. Contact an active Admin.',
        administrators.map(({ displayName, email }) => ({ displayName, email })),
      );
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  async checkReadiness(): Promise<void> {
    this.ensureDatabaseAvailable();
    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      throw new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
        'The Resource Allocation database is unavailable.', undefined, error,
      );
    }
  }

  async checkStartup(): Promise<void> {
    await this.checkReadiness();
    try {
      const appliedMigrations = await this.dataSource.query('SELECT name FROM migrations') as Array<{ name: string }>;
      const appliedNames = new Set(appliedMigrations.map(({ name }) => name));
      const pendingMigrations = this.dataSource.migrations.filter((migration) => {
        const name = migration.name ?? migration.constructor.name;
        return !appliedNames.has(name);
      });
      if (pendingMigrations.length > 0) {
        throw new ResourceAllocationException(
          'DEPENDENCY_UNAVAILABLE', 'Startup incomplete', 503,
          'The Resource Allocation database migrations are incomplete.',
        );
      }
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      throw new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Startup incomplete', 503,
        'The Resource Allocation database migrations are incomplete.', undefined, error,
      );
    }
  }
  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
        'The Resource Allocation database is not configured or available.',
      );
    }
  }

  private isLocalSimulationEnabled(): boolean {
    const configured = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED;
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return process.env.NODE_ENV !== 'production';
  }

  private toAccessPerson(person: ResourcePerson): ResourcePersonAccessDto {
    return {
      id: person.id,
      localUserId: person.localUserId,
      displayName: person.displayName,
      role: person.role,
      groupId: person.groupId,
      coveredGroupIds: person.coveredGroupIds,
    };
  }
}
