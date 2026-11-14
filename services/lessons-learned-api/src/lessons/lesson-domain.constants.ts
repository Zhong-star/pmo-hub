export const LESSON_STATUSES = ['Open', 'PMOEvaluation', 'Approved', 'Closed', 'Archived'] as const;
export type LessonStatus = typeof LESSON_STATUSES[number];

export const LESSON_TYPES = ['Future Prevention', 'Success to Repeat', 'Risk Avoided', 'Communication'] as const;
export type LessonType = typeof LESSON_TYPES[number];
