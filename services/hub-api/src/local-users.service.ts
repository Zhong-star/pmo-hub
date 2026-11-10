import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { LocalUserDto } from './local-user.dto';

interface LocalUserConfig {
  id: string;
  displayName: string;
}

@Injectable()
export class LocalUsersService {
  private readonly users: LocalUserDto[];

  constructor() {
    const configuredPath = process.env.HUB_LOCAL_USERS_FILE ?? 'config/local-users.json';
    const filePath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(process.cwd(), configuredPath);

    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      this.users = this.validateUsers(parsed);
    } catch (error) {
      throw new InternalServerErrorException(
        `Unable to load local Hub profiles from ${filePath}.`,
        { cause: error },
      );
    }
  }

  list(): LocalUserDto[] {
    return this.users.map((user) => ({ ...user }));
  }

  findById(id: string): LocalUserDto | undefined {
    const user = this.users.find((candidate) => candidate.id === id);
    return user ? { ...user } : undefined;
  }

  private validateUsers(value: unknown): LocalUserDto[] {
    if (!Array.isArray(value)) {
      throw new Error('Local profiles must be a JSON array.');
    }

    const seenIds = new Set<string>();
    return value.map((candidate: LocalUserConfig) => {
      if (
        typeof candidate?.id !== 'string' ||
        candidate.id.trim() === '' ||
        candidate.id === '.' ||
        candidate.id === '..' ||
        typeof candidate.displayName !== 'string' ||
        candidate.displayName.trim() === ''
      ) {
        throw new Error('Every local profile must have a non-empty id and displayName.');
      }
      if (seenIds.has(candidate.id)) {
        throw new Error(`Duplicate local profile id: ${candidate.id}.`);
      }
      seenIds.add(candidate.id);
      return { id: candidate.id, displayName: candidate.displayName };
    });
  }
}
