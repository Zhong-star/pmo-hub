import type { SelectQueryBuilder } from 'typeorm';
import type { LessonSearchFilters } from './lesson-submissions-query.dto';
import type { Lesson } from './lesson.entity';

const libraryTitleWithoutMarks = "REGEXP_REPLACE(NORMALIZE(LOWER(lesson.title), NFD), U&'[\\0300-\\036F\\1AB0-\\1AFF\\1DC0-\\1DFF\\20D0-\\20FF\\FE20-\\FE2F]', '', 'g')";
const libraryCombiningMarkRanges = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
] as const;

export function normalizeLessonSearch(value: string): string {
  return [...value.toLowerCase().normalize('NFD')]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return !libraryCombiningMarkRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
    })
    .join('');
}

export function applyLessonSearchFilters(
  query: SelectQueryBuilder<Lesson>,
  filters: LessonSearchFilters,
  librarySearch = false,
): void {
  if (filters.search) {
    if (librarySearch) {
      const exactId = /^#([0-9]+)$/.exec(filters.search);
      const titlePrefix = normalizeLessonSearch(filters.search);
      if (exactId) {
        const lessonId = Number(exactId[1]);
        if (Number.isSafeInteger(lessonId) && lessonId > 0 && lessonId <= 2_147_483_647) {
          query.andWhere('lesson.id = :lessonId', { lessonId });
        } else {
          query.andWhere('1 = 0');
        }
      } else if (/^[0-9]+$/.test(filters.search)) {
        const lessonId = Number(filters.search);
        const titleQuery = `LEFT(${libraryTitleWithoutMarks}, CHAR_LENGTH(:titlePrefix)) = :titlePrefix`;
        if (Number.isSafeInteger(lessonId) && lessonId <= 2_147_483_647) {
          query.andWhere(`(lesson.id = :lessonId OR ${titleQuery})`, { lessonId, titlePrefix });
        } else {
          query.andWhere(titleQuery, { titlePrefix });
        }
      } else {
        query.andWhere(`LEFT(${libraryTitleWithoutMarks}, CHAR_LENGTH(:titlePrefix)) = :titlePrefix`, { titlePrefix });
      }
    } else if (/^\d+$/.test(filters.search)) {
      const lessonId = Number(filters.search);
      if (Number.isSafeInteger(lessonId) && lessonId <= 2_147_483_647) {
        query.andWhere(
          '(lesson.id = :lessonId OR LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix))',
          { lessonId, titlePrefix: filters.search },
        );
      } else {
        query.andWhere(
          'LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix)',
          { titlePrefix: filters.search },
        );
      }
    } else {
      query.andWhere(
        'LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix)',
        { titlePrefix: filters.search },
      );
    }
  }
  if (filters.withoutProject) query.andWhere('lesson.project_id IS NULL');
  if (filters.projectId) query.andWhere('lesson.project_id = :projectId', { projectId: filters.projectId });
  if (filters.lessonType) query.andWhere('lesson.lesson_type = :lessonType', { lessonType: filters.lessonType });
}
