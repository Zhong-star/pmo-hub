import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { LocalAccessService, LocalProfile } from '../local-access.service';
import { isRepresentationETag, lessonRepresentationETag } from './lesson-http-contract';
import { readDetailsRepresentation, toLessonDraftResponse, withLibraryAuthor } from './lesson-read-model';
import type { LessonDraftResponse } from './lesson-response.dto';
import type { Lesson } from './lesson.entity';

export async function checkLessonIfMatch(
  ifMatch: string | undefined,
  expectedVersion: number,
  current: Lesson,
  profile: LocalProfile,
  manager: EntityManager,
  localAccess: LocalAccessService,
): Promise<void> {
  if (!ifMatch) return;
  if (current.version !== expectedVersion) throw staleLessonVersionConflict();
  if (!isRepresentationETag(ifMatch)) return;

  const matches = (response: LessonDraftResponse) =>
    [false, true].some((includeInBody) => lessonRepresentationETag(response, includeInBody) === ifMatch);
  const draft = toLessonDraftResponse(current);
  if (matches(draft)) return;

  const details = await readDetailsRepresentation(current, profile, manager);
  if (matches(details) || matches({ ...draft, latestReviewGuidance: details.latestReviewGuidance })) return;
  if (current.approvedAt && (current.status === 'Approved' || current.status === 'Closed')
    && matches(withLibraryAuthor(details, localAccess))) return;
  throw staleLessonVersionConflict();
}

export function staleLessonVersionConflict(): ConflictException {
  return new ConflictException({
    code: 'STALE_LESSON_VERSION',
    message: 'This draft changed after you opened it. Reload the current version before saving again.',
  });
}
