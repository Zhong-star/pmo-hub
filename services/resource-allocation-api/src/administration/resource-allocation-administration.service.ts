import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { CreateInitiativeRequestDto, UpdateInitiativeRequestDto } from '../initiatives/initiative-request.dto';
import { nextAdminCollectionCursor, parseAdminCollectionQuery } from './admin-collection-page';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import {
  CreateResourceGroupRequestDto,
  CreateResourceProfileRequestDto,
  CreateResourcePersonRequestDto,
  ResourceGroupSelectionDto,
  ResourcePersonSelectionDto,
  ResourceProfileSelectionDto,
  UpdateResourceProfileRequestDto,
  UpdateResourceGroupRequestDto,
  UpdateResourcePersonRequestDto,
} from './resource-administration.dto';
import { runIdempotentOperation } from './idempotency/run-idempotent-operation';

const adminMutationLockKey = 20261120;

@Injectable()
export class ResourceAllocationAdministrationService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async listInitiatives(
    localUserId: string | undefined,
    filters: { limit?: string; cursor?: string; active?: string },
  ) {
    await this.requireAdmin(localUserId);
    const page = parseAdminCollectionQuery('initiatives', filters);
    const query = this.dataSource.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .orderBy('initiative.id', 'ASC')
      .take(page.limit + 1);
    if (page.active !== undefined) query.andWhere('initiative.active = :active', { active: page.active });
    if (page.afterId) query.andWhere('initiative.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    const hasNext = found.length > page.limit;
    const items = found.slice(0, page.limit);
    return {
      items: items.map((initiative) => this.toInitiative(initiative)),
      page: {
        nextCursor: hasNext && items.length > 0
          ? nextAdminCollectionCursor('initiatives', page.active, items[items.length - 1].id)
          : null,
        limit: page.limit,
      },
    };
  }

  async getInitiative(localUserId: string | undefined, id: string): Promise<ResourceInitiative> {
    await this.requireAdmin(localUserId);
    const initiative = await this.dataSource.getRepository(ResourceInitiative).findOne({ where: { id } });
    if (!initiative) throw this.notFound('ITDM');
    return initiative;
  }

  async listPeople(localUserId: string | undefined, filters: { limit?: string; cursor?: string; active?: string }) {
    await this.requireAdmin(localUserId);
    const page = parseAdminCollectionQuery('people', filters);
    const query = this.dataSource.getRepository(ResourcePerson).createQueryBuilder('person')
      .orderBy('person.id', 'ASC')
      .take(page.limit + 1);
    if (page.active !== undefined) query.andWhere('person.active = :active', { active: page.active });
    if (page.afterId) query.andWhere('person.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    const hasNext = found.length > page.limit;
    const people = found.slice(0, page.limit);
    return {
      items: people.map((person) => this.toPerson(person)),
      page: {
        nextCursor: hasNext && people.length > 0
          ? nextAdminCollectionCursor('people', page.active, people[people.length - 1].id)
          : null,
        limit: page.limit,
      },
    };
  }

  async getPerson(localUserId: string | undefined, id: string) {
    await this.requireAdmin(localUserId);
    const person = await this.dataSource.getRepository(ResourcePerson).findOne({ where: { id } });
    if (!person) throw this.notFound('Person');
    return this.toPerson(person);
  }

  async createPerson(localUserId: string | undefined, idempotencyKey: string | undefined, input: CreateResourcePersonRequestDto) {
    const key = this.parseIdempotencyKey(idempotencyKey);
    try {
      return await this.withAdminMutation(localUserId, async (manager, actor) => {
        const role = input.role;
        const active = input.active ?? true;
        const normalizedInput = {
          localUserId: input.localUserId.trim(),
          displayName: input.displayName.trim(),
          email: input.email.trim(),
          role,
          active,
          groupId: input.groupId ?? null,
        };
        const operation = await runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'admin.createPerson',
          key,
          payload: normalizedInput,
        }, async () => {
          const groupId = await this.validatePersonGroup(manager, role, normalizedInput.groupId, active);
          const repository = manager.getRepository(ResourcePerson);
          const person = await repository.save(repository.create({
            ...normalizedInput,
            groupId,
            coveredGroupIds: [],
          }));
          return this.toPerson(person);
        });
        return operation;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Resource conflict', 409, 'A person with this local profile already exists.');
      }
      throw this.translateDatabaseError(error);
    }
  }

  async updatePerson(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    input: UpdateResourcePersonRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    if (Object.keys(input).length === 0) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'At least one editable field is required.');
    }
    try {
      return await this.withAdminMutation(localUserId, async (manager) => {
        const repository = manager.getRepository(ResourcePerson);
        const person = await repository.createQueryBuilder('person')
          .setLock('pessimistic_write')
          .where('person.id = :id', { id })
          .getOne();
        if (!person) throw this.notFound('Person');
        if (person.version !== expectedVersion) {
          throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The person changed. Reload the record before saving.');
        }
        const nextRole = input.role ?? person.role;
        const nextActive = input.active ?? person.active;
        const nextGroupId = input.groupId === undefined ? person.groupId : input.groupId;
        await this.ensurePersonCanChangeRoleOrActive(manager, person, nextRole, nextActive);
        person.localUserId = input.localUserId?.trim() ?? person.localUserId;
        person.displayName = input.displayName?.trim() ?? person.displayName;
        person.email = input.email?.trim() ?? person.email;
        person.role = nextRole;
        person.active = nextActive;
        person.groupId = await this.validatePersonGroup(manager, nextRole, nextGroupId, nextActive);
        return this.toPerson(await repository.save(person));
      });
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      if (this.isUniqueViolation(error)) {
        throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Resource conflict', 409, 'A person with this local profile already exists.');
      }
      throw this.translateDatabaseError(error);
    }
  }

  async listGroups(localUserId: string | undefined, filters: { limit?: string; cursor?: string; active?: string }) {
    await this.requireAdmin(localUserId);
    const page = parseAdminCollectionQuery('groups', filters);
    const query = this.dataSource.getRepository(ResourceGroup).createQueryBuilder('group')
      .orderBy('group.id', 'ASC')
      .take(page.limit + 1);
    if (page.active !== undefined) query.andWhere('group.active = :active', { active: page.active });
    if (page.afterId) query.andWhere('group.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    const hasNext = found.length > page.limit;
    const groups = found.slice(0, page.limit);
    return {
      items: groups.map((group) => this.toGroup(group)),
      page: {
        nextCursor: hasNext && groups.length > 0
          ? nextAdminCollectionCursor('groups', page.active, groups[groups.length - 1].id)
          : null,
        limit: page.limit,
      },
    };
  }

  async getGroup(localUserId: string | undefined, id: string) {
    await this.requireAdmin(localUserId);
    const group = await this.dataSource.getRepository(ResourceGroup).findOne({ where: { id } });
    if (!group) throw this.notFound('Group');
    return this.toGroup(group);
  }

  async createGroup(localUserId: string | undefined, idempotencyKey: string | undefined, input: CreateResourceGroupRequestDto) {
    const key = this.parseIdempotencyKey(idempotencyKey);
    return this.withAdminMutation(localUserId, async (manager, actor) => {
      const active = input.active ?? true;
      const supervisorId = input.supervisorId ?? null;
      const managerId = input.managerId ?? null;
      const normalizedInput = { name: input.name.trim(), active, supervisorId, managerId };
      const operation = await runIdempotentOperation(manager, {
        actorId: actor.id,
        operation: 'admin.createGroup',
        key,
        payload: normalizedInput,
      }, async () => {
        await this.validateGroupResponsibles(manager, active, supervisorId, managerId);
        const repository = manager.getRepository(ResourceGroup);
        const group = await repository.save(repository.create(normalizedInput));
        await this.refreshLeadershipCoverage(manager, [supervisorId, managerId]);
        return this.toGroup(group);
      });
      return operation;
    });
  }

  async updateGroup(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    input: UpdateResourceGroupRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    if (Object.keys(input).length === 0) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'At least one editable field is required.');
    }
    return this.withAdminMutation(localUserId, async (manager) => {
      const repository = manager.getRepository(ResourceGroup);
      const group = await repository.createQueryBuilder('group')
        .setLock('pessimistic_write')
        .where('group.id = :id', { id })
        .getOne();
      if (!group) throw this.notFound('Group');
      if (group.version !== expectedVersion) {
        throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The group changed. Reload the record before saving.');
      }
      const previousResponsibles = [group.supervisorId, group.managerId];
      const nextActive = input.active ?? group.active;
      const nextSupervisorId = input.supervisorId === undefined ? group.supervisorId : input.supervisorId;
      const nextManagerId = input.managerId === undefined ? group.managerId : input.managerId;
      await this.validateGroupResponsibles(manager, nextActive, nextSupervisorId, nextManagerId);
      if (input.name !== undefined) group.name = input.name.trim();
      group.active = nextActive;
      group.supervisorId = nextSupervisorId;
      group.managerId = nextManagerId;
      const saved = await repository.save(group);
      await this.refreshLeadershipCoverage(manager, [...previousResponsibles, nextSupervisorId, nextManagerId]);
      return this.toGroup(saved);
    });
  }

  async listResourceProfiles(localUserId: string | undefined, filters: { limit?: string; cursor?: string; active?: string }) {
    await this.requireAdmin(localUserId);
    const page = parseAdminCollectionQuery('resource-profiles', filters);
    const query = this.dataSource.getRepository(ResourceProfile).createQueryBuilder('profile')
      .orderBy('profile.id', 'ASC')
      .take(page.limit + 1);
    if (page.active !== undefined) query.andWhere('profile.active = :active', { active: page.active });
    if (page.afterId) query.andWhere('profile.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    const hasNext = found.length > page.limit;
    const profiles = found.slice(0, page.limit);
    return {
      items: profiles.map((profile) => this.toResourceProfile(profile)),
      page: {
        nextCursor: hasNext && profiles.length > 0
          ? nextAdminCollectionCursor('resource-profiles', page.active, profiles[profiles.length - 1].id)
          : null,
        limit: page.limit,
      },
    };
  }

  async getResourceProfile(localUserId: string | undefined, id: string) {
    await this.requireAdmin(localUserId);
    const profile = await this.dataSource.getRepository(ResourceProfile).findOne({ where: { id } });
    if (!profile) throw this.notFound('Resource profile');
    return this.toResourceProfile(profile);
  }

  async createResourceProfile(localUserId: string | undefined, idempotencyKey: string | undefined, input: CreateResourceProfileRequestDto) {
    const key = this.parseIdempotencyKey(idempotencyKey);
    return this.withAdminMutation(localUserId, async (manager, actor) => {
      const active = input.active ?? true;
      const normalizedInput = { name: input.name.trim(), groupId: input.groupId, active };
      return runIdempotentOperation(manager, {
        actorId: actor.id,
        operation: 'admin.createResourceProfile',
        key,
        payload: normalizedInput,
      }, async () => {
        await this.validateProfileGroup(manager, input.groupId, active);
        const repository = manager.getRepository(ResourceProfile);
        return this.toResourceProfile(await repository.save(repository.create(normalizedInput)));
      });
    });
  }

  async updateResourceProfile(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    input: UpdateResourceProfileRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    if (Object.keys(input).length === 0) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'At least one editable field is required.');
    }
    return this.withAdminMutation(localUserId, async (manager) => {
      const repository = manager.getRepository(ResourceProfile);
      const profile = await repository.createQueryBuilder('profile')
        .setLock('pessimistic_write')
        .where('profile.id = :id', { id })
        .getOne();
      if (!profile) throw this.notFound('Resource profile');
      if (profile.version !== expectedVersion) {
        throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The resource profile changed. Reload it before saving.');
      }
      const nextGroupId = input.groupId ?? profile.groupId;
      const nextActive = input.active ?? profile.active;
      await this.validateProfileGroup(manager, nextGroupId, nextActive);
      if (input.name !== undefined) profile.name = input.name.trim();
      profile.groupId = nextGroupId;
      profile.active = nextActive;
      return this.toResourceProfile(await repository.save(profile));
    });
  }

  async listSelectablePeople(localUserId: string | undefined, filters: { limit?: string; cursor?: string; groupId?: string }) {
    await this.requireActivePerson(localUserId);
    const page = parseAdminCollectionQuery('selection-people', { ...filters, active: 'true' });
    const query = this.dataSource.getRepository(ResourcePerson).createQueryBuilder('person')
      .where('person.active = TRUE')
      .orderBy('person.id', 'ASC')
      .take(page.limit + 1);
    if (page.afterId) query.andWhere('person.id > :afterId', { afterId: page.afterId });
    if (page.filters?.groupId) query.andWhere('person.group_id = :groupId', { groupId: page.filters.groupId });
    const found = await query.getMany();
    return this.toSelectionPage('selection-people', page, found, (person): ResourcePersonSelectionDto => ({
      id: person.id, displayName: person.displayName, groupId: person.groupId,
    }));
  }

  async listSelectableGroups(localUserId: string | undefined, filters: { limit?: string; cursor?: string }) {
    await this.requireActivePerson(localUserId);
    const page = parseAdminCollectionQuery('selection-groups', { ...filters, active: 'true' });
    const query = this.dataSource.getRepository(ResourceGroup).createQueryBuilder('group')
      .where('group.active = TRUE')
      .orderBy('group.id', 'ASC')
      .take(page.limit + 1);
    if (page.afterId) query.andWhere('group.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    return this.toSelectionPage('selection-groups', page, found, (group): ResourceGroupSelectionDto => ({
      id: group.id, name: group.name,
    }));
  }

  async listSelectableResourceProfiles(localUserId: string | undefined, filters: { limit?: string; cursor?: string; groupId?: string }) {
    await this.requireActivePerson(localUserId);
    const page = parseAdminCollectionQuery('selection-resource-profiles', { ...filters, active: 'true' });
    const query = this.dataSource.getRepository(ResourceProfile).createQueryBuilder('profile')
      .innerJoin(ResourceGroup, 'group', 'group.id = profile.group_id AND group.active = TRUE')
      .where('profile.active = TRUE')
      .orderBy('profile.id', 'ASC')
      .take(page.limit + 1);
    if (page.afterId) query.andWhere('profile.id > :afterId', { afterId: page.afterId });
    if (page.filters?.groupId) query.andWhere('profile.group_id = :groupId', { groupId: page.filters.groupId });
    const found = await query.getMany();
    return this.toSelectionPage('selection-resource-profiles', page, found, (profile): ResourceProfileSelectionDto => ({
      id: profile.id, name: profile.name, groupId: profile.groupId,
    }));
  }

  async listSelectableInitiatives(localUserId: string | undefined, filters: { limit?: string; cursor?: string }) {
    await this.requireActivePerson(localUserId);
    const page = parseAdminCollectionQuery('selection-initiatives', { ...filters, active: 'true' });
    const query = this.dataSource.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .where('initiative.active = TRUE')
      .orderBy('initiative.id', 'ASC')
      .take(page.limit + 1);
    if (page.afterId) query.andWhere('initiative.id > :afterId', { afterId: page.afterId });
    const found = await query.getMany();
    return this.toSelectionPage('selection-initiatives', page, found, (initiative) => ({
      id: initiative.id, code: initiative.code, name: initiative.name,
    }));
  }

  private toSelectionPage<T extends { id: string }, S>(
    collection: string,
    page: { limit: number; active?: boolean; filters?: Record<string, string> },
    found: T[],
    map: (item: T) => S,
  ) {
    const hasNext = found.length > page.limit;
    const items = found.slice(0, page.limit);
    return {
      items: items.map(map),
      page: {
        nextCursor: hasNext && items.length > 0
          ? nextAdminCollectionCursor(collection, page.active, items[items.length - 1].id, page.filters)
          : null,
        limit: page.limit,
      },
    };
  }

  private async validateProfileGroup(manager: EntityManager, groupId: string, active: boolean): Promise<void> {
    const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: groupId } });
    if (!group || (active && !group.active)) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'An active resource profile needs an active group.');
    }
  }

  private toResourceProfile(profile: ResourceProfile) {
    return {
      id: profile.id,
      name: profile.name,
      groupId: profile.groupId,
      active: profile.active,
      version: profile.version,
    };
  }

  private toPerson(person: ResourcePerson) {
    return {
      id: person.id,
      localUserId: person.localUserId,
      displayName: person.displayName,
      email: person.email,
      active: person.active,
      role: person.role,
      groupId: person.groupId,
      coveredGroupIds: person.coveredGroupIds,
      version: person.version,
    };
  }

  private toGroup(group: ResourceGroup) {
    return {
      id: group.id,
      name: group.name,
      active: group.active,
      supervisorId: group.supervisorId,
      managerId: group.managerId,
      version: group.version,
    };
  }

  private async validatePersonGroup(
    manager: EntityManager,
    role: ResourceAllocationRole,
    groupId: string | null,
    active: boolean,
  ): Promise<string | null> {
    if (role === ResourceAllocationRole.Moderator && !groupId) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'A Moderator must belong to an active group.');
    }
    if (groupId) {
      const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: groupId } });
      if (!group || (active && !group.active)) {
        throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The selected group must exist and be active.');
      }
    }
    return groupId;
  }

  private async ensurePersonCanChangeRoleOrActive(
    manager: EntityManager,
    person: ResourcePerson,
    nextRole: ResourceAllocationRole,
    nextActive: boolean,
  ): Promise<void> {
    if (person.role === ResourceAllocationRole.Admin && person.active &&
      (nextRole !== ResourceAllocationRole.Admin || !nextActive)) {
      const activeAdmins = await manager.getRepository(ResourcePerson).count({
        where: { role: ResourceAllocationRole.Admin, active: true },
      });
      if (activeAdmins <= 1) {
        throw new ResourceAllocationException('LAST_ACTIVE_ADMIN_REQUIRED', 'Last active Admin required', 422, 'At least one active Admin must remain.');
      }
    }

    const assignedGroups = await manager.getRepository(ResourceGroup).find({
      where: [
        { active: true, supervisorId: person.id },
        { active: true, managerId: person.id },
      ],
    });
    const incompatibleAssignment = assignedGroups.some((group) =>
      !nextActive ||
      (group.supervisorId === person.id && nextRole !== ResourceAllocationRole.Supervisor) ||
      (group.managerId === person.id && nextRole !== ResourceAllocationRole.Manager));
    if (incompatibleAssignment) {
      throw new ResourceAllocationException('RESPONSIBLE_REPLACEMENT_REQUIRED', 'Responsible replacement required', 422, 'Replace the responsible person on each active group before changing this person.');
    }
  }

  private async validateGroupResponsibles(
    manager: EntityManager,
    active: boolean,
    supervisorId: string | null,
    managerId: string | null,
  ): Promise<void> {
    if (!active) return;
    if (!supervisorId || !managerId) {
      throw new ResourceAllocationException('RESPONSIBLE_REPLACEMENT_REQUIRED', 'Responsible replacement required', 422, 'An active group needs an active Supervisor and Manager.');
    }
    const supervisor = await manager.getRepository(ResourcePerson).findOne({ where: { id: supervisorId, active: true } });
    if (!supervisor || supervisor.role !== ResourceAllocationRole.Supervisor) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active Supervisor for the group.');
    }
    const groupManager = await manager.getRepository(ResourcePerson).findOne({ where: { id: managerId, active: true } });
    if (!groupManager || groupManager.role !== ResourceAllocationRole.Manager) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active Manager for the group.');
    }
  }

  private async refreshLeadershipCoverage(manager: EntityManager, personIds: Array<string | null>): Promise<void> {
    for (const personId of [...new Set(personIds.filter((id): id is string => Boolean(id)))]) {
      const personRepository = manager.getRepository(ResourcePerson);
      const person = await personRepository.findOne({ where: { id: personId } });
      if (!person) continue;
      const groups = await manager.getRepository(ResourceGroup).find({
        where: [
          { active: true, supervisorId: person.id },
          { active: true, managerId: person.id },
        ],
        order: { id: 'ASC' },
      });
      const coveredGroupIds = groups.map((group) => group.id);
      if (person.coveredGroupIds.length !== coveredGroupIds.length ||
        person.coveredGroupIds.some((id, index) => id !== coveredGroupIds[index])) {
        person.coveredGroupIds = coveredGroupIds;
        await personRepository.save(person);
      }
    }
  }

  async createInitiative(localUserId: string | undefined, idempotencyKey: string | undefined, input: CreateInitiativeRequestDto) {
    const key = this.parseIdempotencyKey(idempotencyKey);
    const normalizedInput = {
      code: input.code.trim(),
      name: input.name.trim(),
      active: input.active ?? true,
    };
    try {
      return await this.withAdminMutation(localUserId, async (manager, actor) => {
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'admin.createInitiative',
          key,
          payload: normalizedInput,
        }, async () => {
          const repository = manager.getRepository(ResourceInitiative);
          const initiative = await repository.save(repository.create(normalizedInput));
          return this.toInitiative(initiative);
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Resource conflict', 409, 'An ITDM with this code already exists.');
      }
      throw this.translateDatabaseError(error);
    }
  }

  async updateInitiative(
    localUserId: string | undefined,
    id: string,
    ifMatch: string | undefined,
    input: UpdateInitiativeRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    if (Object.keys(input).length === 0) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'At least one editable field is required.');
    }
    const normalizedCode = input.code?.trim();
    const normalizedName = input.name?.trim();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.lockAdministrationWrites(manager);
        await this.requireAdmin(localUserId, manager);
        const repository = manager.getRepository(ResourceInitiative);
        const initiative = await repository.createQueryBuilder('initiative')
          .addSelect('initiative.codeUsed')
          .setLock('pessimistic_write')
          .where('initiative.id = :id', { id })
          .getOne();
        if (!initiative) throw this.notFound('ITDM');
        if (initiative.version !== expectedVersion) {
          throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The ITDM changed. Reload it before saving.');
        }
        if (normalizedCode !== undefined && normalizedCode !== initiative.code && initiative.codeUsed) {
          throw new ResourceAllocationException('ITDM_CODE_IMMUTABLE', 'ITDM code is immutable', 422, 'The ITDM code cannot change after a request uses it.');
        }
        if (normalizedCode !== undefined) initiative.code = normalizedCode;
        if (normalizedName !== undefined) initiative.name = normalizedName;
        if (input.active !== undefined) initiative.active = input.active;
        return this.toInitiative(await repository.save(initiative));
      });
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      if (this.isUniqueViolation(error)) {
        throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Resource conflict', 409, 'An ITDM with this code already exists.');
      }
      throw this.translateDatabaseError(error);
    }
  }

  private async lockAdministrationWrites(manager: EntityManager): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [adminMutationLockKey, 59]);
  }

  private async withAdminMutation<T>(
    localUserId: string | undefined,
    operation: (manager: EntityManager, actor: ResourcePerson) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockAdministrationWrites(manager);
      const actor = await this.requireAdmin(localUserId, manager);
      return operation(manager, actor);
    });
  }

  private parseIdempotencyKey(value: string | undefined): string {
    if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'A UUID Idempotency-Key header is required.');
    }
    return value.toLowerCase();
  }

  private toInitiative(initiative: ResourceInitiative) {
    return {
      id: initiative.id,
      code: initiative.code,
      name: initiative.name,
      active: initiative.active,
      version: initiative.version,
    };
  }

  private parseIfMatch(ifMatch: string | undefined): number {
    const match = ifMatch?.match(/^"([1-9][0-9]*)"$/);
    if (!match) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'A single strong If-Match version is required.');
    }
    return Number(match[1]);
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private isUniqueViolation(error: unknown): boolean {
    let cause = error;
    for (let depth = 0; depth < 4 && cause; depth += 1) {
      if (typeof cause !== 'object') return false;
      const value = cause as { code?: unknown; driverError?: unknown; cause?: unknown };
      if (value.code === '23505') return true;
      cause = value.driverError ?? value.cause;
    }
    return false;
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
        'The Resource Allocation database is unavailable or not prepared.', undefined, error,
      );
    }
    throw new ResourceAllocationException(
      'INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error,
    );
  }

  private async requireAdmin(localUserId: string | undefined, manager?: EntityManager): Promise<ResourcePerson> {
    const person = await this.requireActivePerson(localUserId, manager);
    if (person.role !== ResourceAllocationRole.Admin) {
      throw new ResourceAllocationException(
        'ACCESS_DENIED', 'Access denied', 403,
        'Only an active Tech Resource Allocation Admin can manage administrative records.',
      );
    }
    return person;
  }

  private async requireActivePerson(localUserId: string | undefined, manager?: EntityManager): Promise<ResourcePerson> {
    if (!this.isLocalSimulationEnabled()) {
      throw new ResourceAllocationException(
        'LOCAL_AUTH_DISABLED', 'Local access disabled', 503,
        'Local simulated access is not enabled for this runtime.',
      );
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException(
        'AUTHENTICATION_REQUIRED', 'Local profile required', 401,
        'Select a local Hub profile before managing Tech Resource Allocation.',
      );
    }
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException(
        'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
        'The Resource Allocation database is not configured or available.',
      );
    }

    try {
      const repository = manager?.getRepository(ResourcePerson) ?? this.dataSource.getRepository(ResourcePerson);
      const person = await repository.findOne({
        where: { localUserId, active: true },
      });
      if (!person) {
        throw new ResourceAllocationException(
          'ACCESS_DENIED', 'Access denied', 403,
          'An active Tech Resource Allocation profile is required.',
        );
      }
      return person;
    } catch (error) {
      if (error instanceof ResourceAllocationException) throw error;
      if (isDatabaseUnavailable(error)) {
        throw new ResourceAllocationException(
          'DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503,
          'The Resource Allocation database is unavailable or not prepared.', undefined, error,
        );
      }
      throw new ResourceAllocationException(
        'INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error,
      );
    }
  }

  private isLocalSimulationEnabled(): boolean {
    const configured = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED;
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return process.env.NODE_ENV !== 'production';
  }
}
