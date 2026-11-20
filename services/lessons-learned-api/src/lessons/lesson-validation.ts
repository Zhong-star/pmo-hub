import { BadRequestException } from '@nestjs/common';
import type { Lesson } from './lesson.entity';
import type { ProjectCatalogService } from './project-catalog.service';

export type EvaluationFields = Pick<
  Lesson,
  | 'title'
  | 'projectCategory'
  | 'projectPhase'
  | 'situationObserved'
  | 'rootCause'
  | 'lessonType'
  | 'impact'
  | 'recommendation'
  | 'applicability'
>;

export function validateProjectSelection(
  projectCatalog: ProjectCatalogService,
  current: Lesson | null,
  projectId: string | null,
  projectName: string | null,
): void {
  if (projectId === null && projectName === null) return;
  if (
    typeof projectId !== 'string' || projectId.trim() === '' ||
    typeof projectName !== 'string' || projectName.trim() === ''
  ) {
    throw new BadRequestException({
      code: 'INVALID_PROJECT_SELECTION',
      message: 'Select a project from the local catalog or clear the project selection.',
    });
  }

  const unchangedSnapshot = current !== null &&
    projectId === current.projectId && projectName === current.projectName;
  if (unchangedSnapshot) return;

  const catalogMatches = projectCatalog.list().some(
    (project) => project.id === projectId && project.name === projectName,
  );
  if (!catalogMatches) {
    throw new BadRequestException({
      code: 'INVALID_PROJECT_SELECTION',
      message: 'Select a project from the local catalog or clear the project selection.',
    });
  }
}

export function evaluationCompletenessErrors(fields: EvaluationFields): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const requireText = (field: string, value: string | null, label: string) => {
    if (!value?.trim()) fieldErrors[field] = `${label} is required.`;
  };

  requireText('title', fields.title, 'Title');
  if (!fields.projectCategory) fieldErrors.projectCategory = 'Project category is required.';
  if (!fields.projectPhase) fieldErrors.projectPhase = 'Project phase is required.';
  requireText('situationObserved', fields.situationObserved, 'Situation observed');
  if (!fields.lessonType) fieldErrors.lessonType = 'Lesson type is required.';
  requireText('impact', fields.impact, 'Impact');
  requireText('recommendation', fields.recommendation, 'Recommendation');
  requireText('applicability', fields.applicability, 'Applicability');
  if (fields.lessonType === 'Future Prevention') requireText('rootCause', fields.rootCause, 'Root cause');

  return fieldErrors;
}
