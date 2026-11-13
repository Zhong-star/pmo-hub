import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface LessonProject {
  id: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ProjectCatalogService {
  list(): LessonProject[] {
    const configuredPath = process.env.LESSONS_LEARNED_PROJECTS_FILE ?? 'config/projects.json';
    const filePath = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch (error) {
      throw new InternalServerErrorException({
        code: 'PROJECT_CATALOG_UNAVAILABLE',
        message: 'The local project catalog could not be read.',
        cause: error instanceof Error ? error.message : undefined,
      });
    }

    if (!Array.isArray(parsed)) throw this.invalidCatalog();
    const projects: LessonProject[] = [];
    const ids = new Set<string>();
    for (const candidate of parsed) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== 'string' || candidate.id.trim() === '' || candidate.id.length > 128 ||
        typeof candidate.name !== 'string' || candidate.name.trim() === '' || candidate.name.length > 200 ||
        ids.has(candidate.id)
      ) {
        throw this.invalidCatalog();
      }
      ids.add(candidate.id);
      projects.push({ id: candidate.id, name: candidate.name });
    }
    return projects;
  }

  private invalidCatalog(): InternalServerErrorException {
    return new InternalServerErrorException({
      code: 'PROJECT_CATALOG_INVALID',
      message: 'The local project catalog is invalid.',
    });
  }
}
