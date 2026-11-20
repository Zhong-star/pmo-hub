import { expect, type APIRequestContext } from '@playwright/test';

const lessonsPath = 'http://127.0.0.1:5199/api/lessons-learned/v1/lessons';

type PublishLessonOptions = {
  authorId?: string;
  projectId?: string | null;
  projectName?: string | null;
  lessonType?: 'Future Prevention' | 'Success to Repeat' | 'Risk Avoided' | 'Communication';
};

export async function submitLessonForReview(
  request: APIRequestContext,
  title: string,
  { authorId = 'local-contributor', projectId = null, projectName = null, lessonType = 'Future Prevention' }: PublishLessonOptions = {},
) {
  const authorHeaders = { 'X-PMO-Local-User-ID': authorId };
  const createdResponse = await request.post(lessonsPath, {
    headers: authorHeaders,
    data: { title },
  });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();

  const submittedResponse = await request.post(`${lessonsPath}/${created.id}/submit`, {
    headers: authorHeaders,
    data: {
      version: created.version,
      title,
      projectId,
      projectName,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: `Description for ${title}.`,
      rootCause: 'No checklist owner had been assigned.',
      lessonType,
      impact: 'The next team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with similar delivery risks.',
    },
  });
  expect(submittedResponse.status()).toBe(200);
  return submittedResponse.json() as Promise<{ id: number; version: number }>;
}

export async function publishLesson(request: APIRequestContext, title: string, options?: PublishLessonOptions) {
  const submitted = await submitLessonForReview(request, title, options);
  const approvedResponse = await request.post(`${lessonsPath}/${submitted.id}/approve`, {
    headers: { 'X-PMO-Local-User-ID': 'local-pmo' },
    data: { version: submitted.version },
  });
  expect(approvedResponse.status()).toBe(200);
  return approvedResponse.json() as Promise<{ id: number; approvedAt: string; version: number }>;
}
