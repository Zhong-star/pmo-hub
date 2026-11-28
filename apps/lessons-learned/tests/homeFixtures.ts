import type { HomeResponse } from '../src/api';

/** Role-neutral Home sections for tests that only need an authorized Home access check. */
export const emptyHomeSections: Omit<HomeResponse, 'profile' | 'navigation'> = {
  notifications: { unreadCount: 0, items: [] },
  recentWork: [],
  recentlyApprovedLessons: [],
  highlights: {
    returnedCount: 0,
    returnedLessons: [],
    openDraftCount: 0,
    openDraftLessons: [],
    pendingEvaluationCount: 0,
    pendingEvaluationLessons: [],
  },
  primaryAction: {
    kind: 'explore-library',
    label: 'Explore Lessons Library',
    description: 'Browse published lessons from across the organization.',
    targetPage: 'library',
    lessonId: null,
  },
  shortcuts: [],
};
