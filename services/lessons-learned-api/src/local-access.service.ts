import { Injectable, ForbiddenException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { LessonsLearnedHomeResponse } from './home-response.dto';

type LessonsLearnedRole = 'LESSONS_USER' | 'LESSONS_MODERATOR';

interface LocalProfile {
  id: string;
  displayName: string;
  role: LessonsLearnedRole;
}

function accessDenied(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'ACCESS_DENIED',
    message: 'Access denied.',
  });
}

function configurationError(cause?: unknown): InternalServerErrorException {
  return new InternalServerErrorException({
    statusCode: 500,
    code: 'ACCESS_CONFIGURATION_ERROR',
    message: 'Lessons Learned access configuration is invalid.',
  }, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class LocalAccessService {
  getHome(localUserId: string | undefined): LessonsLearnedHomeResponse {
    if (!this.isLocalSimulationEnabled()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'LOCAL_AUTH_DISABLED',
        message: 'Local simulated access is not enabled for this runtime.',
      });
    }

    if (!localUserId?.trim()) throw accessDenied();

    const matches = this.readProfiles().filter((candidate) => candidate.id === localUserId);
    if (matches.length === 0) throw accessDenied();
    if (matches.length > 1) throw configurationError();
    const [profile] = matches;

    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        role: profile.role,
      },
      navigation: [{ id: 'home', label: 'Home', current: true }],
    };
  }

  private isLocalSimulationEnabled(): boolean {
    const configured = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return process.env.NODE_ENV !== 'production';
  }

  private readProfiles(): LocalProfile[] {
    const configuredPath = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE ?? 'config/local-users.json';
    const filePath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(process.cwd(), configuredPath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch (error) {
      throw configurationError(error);
    }

    if (!Array.isArray(parsed)) throw configurationError();

    const profiles: LocalProfile[] = [];
    for (const candidate of parsed) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== 'string' ||
        candidate.id.trim() === '' ||
        typeof candidate.displayName !== 'string' ||
        candidate.displayName.trim() === '' ||
        (candidate.role !== 'LESSONS_USER' && candidate.role !== 'LESSONS_MODERATOR')
      ) {
        throw configurationError();
      }
      profiles.push({
        id: candidate.id,
        displayName: candidate.displayName,
        role: candidate.role,
      });
    }

    return profiles;
  }
}
