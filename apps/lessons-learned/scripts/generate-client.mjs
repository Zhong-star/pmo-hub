import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(appDirectory, '../../services/lessons-learned-api/openapi/lessons-learned-v1.json');
const outputPath = resolve(appDirectory, 'src/generated/lessons-learned-api-client.ts');
const healthPath = '/api/lessons-learned/v1/health';
const homePath = '/api/lessons-learned/v1/home';
const lessonsPath = '/api/lessons-learned/v1/lessons';
const projectsPath = `${lessonsPath}/projects`;
const submissionsPath = `${lessonsPath}/mine`;
const pmoDraftsPath = `${lessonsPath}/pmo-drafts`;
const pmoDashboardPath = '/api/lessons-learned/v1/pmo/dashboard';
const profilesPath = '/api/lessons-learned/v1/profiles';
const profileDetailPath = `${profilesPath}/{userId}`;
const rankingsPath = '/api/lessons-learned/v1/rankings';
const evaluationQueuePath = `${lessonsPath}/evaluation-queue`;
const evaluationProjectsPath = evaluationQueuePath + '/projects';
const libraryPath = `${lessonsPath}/library`;
const libraryDetailPath = `${libraryPath}/{id}`;
const libraryViewPath = `${libraryDetailPath}/views`;
const libraryProjectsPath = libraryPath + '/projects';
const draftPath = `${lessonsPath}/{id}`;
const submitPath = `${draftPath}/submit`;
const returnPath = `${draftPath}/return`;
const cancelPath = `${draftPath}/cancel`;
const approvePath = `${draftPath}/approve`;
const rejectPath = `${draftPath}/reject`;
const closePath = `${draftPath}/close`;
const votePath = `${draftPath}/vote`;
const commentsPath = `${draftPath}/comments`;
const commentRepliesPath = `${commentsPath}/{commentId}/replies`;
const commentHidePath = `${commentsPath}/{commentId}/hide`;
const notificationsPath = '/api/lessons-learned/v1/notifications';
const notificationReadPath = `${notificationsPath}/{id}/read`;
const notificationsReadBatchPath = `${notificationsPath}/read-batch`;
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const operation = contract.paths?.[healthPath]?.get;
const responseSchema = operation?.responses?.['200']?.content?.['application/json']?.schema;
const homeOperation = contract.paths?.[homePath]?.get;
const homeResponseSchema = homeOperation?.responses?.['200']?.content?.['application/json']?.schema;
const lessonsOperation = contract.paths?.[lessonsPath]?.get;
const lessonsResponseSchema = lessonsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const createLessonOperation = contract.paths?.[lessonsPath]?.post;
const createLessonRequestSchema = createLessonOperation?.requestBody?.content?.['application/json']?.schema;
const createLessonResponseSchema = createLessonOperation?.responses?.['201']?.content?.['application/json']?.schema;
const projectsOperation = contract.paths?.[projectsPath]?.get;
const projectsResponseSchema = projectsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const submissionsOperation = contract.paths?.[submissionsPath]?.get;
const submissionsResponseSchema = submissionsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const pmoDraftsOperation = contract.paths?.[pmoDraftsPath]?.get;
const pmoDraftsResponseSchema = pmoDraftsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const pmoDashboardOperation = contract.paths?.[pmoDashboardPath]?.get;
const pmoDashboardResponseSchema = pmoDashboardOperation?.responses?.['200']?.content?.['application/json']?.schema;
const profilesOperation = contract.paths?.[profilesPath]?.get;
const profilesResponseSchema = profilesOperation?.responses?.['200']?.content?.['application/json']?.schema;
const profileDetailOperation = contract.paths?.[profileDetailPath]?.get;
const profileDetailResponseSchema = profileDetailOperation?.responses?.['200']?.content?.['application/json']?.schema;
const rankingsOperation = contract.paths?.[rankingsPath]?.get;
const rankingsResponseSchema = rankingsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const evaluationQueueOperation = contract.paths?.[evaluationQueuePath]?.get;
const evaluationQueueResponseSchema = evaluationQueueOperation?.responses?.['200']?.content?.['application/json']?.schema;
const libraryOperation = contract.paths?.[libraryPath]?.get;
const libraryResponseSchema = libraryOperation?.responses?.['200']?.content?.['application/json']?.schema;
const libraryDetailOperation = contract.paths?.[libraryDetailPath]?.get;
const libraryDetailResponseSchema = libraryDetailOperation?.responses?.['200']?.content?.['application/json']?.schema;
const libraryViewOperation = contract.paths?.[libraryViewPath]?.post;
const libraryViewRequestSchema = libraryViewOperation?.requestBody?.content?.['application/json']?.schema;
const libraryViewResponseSchema = libraryViewOperation?.responses?.['200']?.content?.['application/json']?.schema;
const libraryProjectsOperation = contract.paths?.[libraryProjectsPath]?.get;
const libraryProjectsResponseSchema = libraryProjectsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const detailsOperation = contract.paths?.[draftPath]?.get;
const detailsResponseSchema = detailsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const updateLessonOperation = contract.paths?.[draftPath]?.patch;
const updateLessonRequestSchema = updateLessonOperation?.requestBody?.content?.['application/json']?.schema;
const updateLessonResponseSchema = updateLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const submitLessonOperation = contract.paths?.[submitPath]?.post;
const submitLessonRequestSchema = submitLessonOperation?.requestBody?.content?.['application/json']?.schema;
const submitLessonResponseSchema = submitLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const returnLessonOperation = contract.paths?.[returnPath]?.post;
const returnLessonRequestSchema = returnLessonOperation?.requestBody?.content?.['application/json']?.schema;
const returnLessonResponseSchema = returnLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const cancelLessonOperation = contract.paths?.[cancelPath]?.post;
const cancelLessonRequestSchema = cancelLessonOperation?.requestBody?.content?.['application/json']?.schema;
const cancelLessonResponseSchema = cancelLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const approveLessonOperation = contract.paths?.[approvePath]?.post;
const approveLessonRequestSchema = approveLessonOperation?.requestBody?.content?.['application/json']?.schema;
const approveLessonResponseSchema = approveLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const rejectLessonOperation = contract.paths?.[rejectPath]?.post;
const rejectLessonRequestSchema = rejectLessonOperation?.requestBody?.content?.['application/json']?.schema;
const rejectLessonResponseSchema = rejectLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const closeLessonOperation = contract.paths?.[closePath]?.post;
const closeLessonRequestSchema = closeLessonOperation?.requestBody?.content?.['application/json']?.schema;
const closeLessonResponseSchema = closeLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const castVoteOperation = contract.paths?.[votePath]?.put;
const castVoteResponseSchema = castVoteOperation?.responses?.['200']?.content?.['application/json']?.schema;
const removeVoteOperation = contract.paths?.[votePath]?.delete;
const removeVoteResponseSchema = removeVoteOperation?.responses?.['200']?.content?.['application/json']?.schema;
const listCommentsOperation = contract.paths?.[commentsPath]?.get;
const listCommentsResponseSchema = listCommentsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const createCommentOperation = contract.paths?.[commentsPath]?.post;
const createCommentRequestSchema = createCommentOperation?.requestBody?.content?.['application/json']?.schema;
const createCommentResponseSchema = createCommentOperation?.responses?.['201']?.content?.['application/json']?.schema;
const createReplyOperation = contract.paths?.[commentRepliesPath]?.post;
const createReplyRequestSchema = createReplyOperation?.requestBody?.content?.['application/json']?.schema;
const createReplyResponseSchema = createReplyOperation?.responses?.['201']?.content?.['application/json']?.schema;
const hideCommentOperation = contract.paths?.[commentHidePath]?.post;
const hideCommentRequestSchema = hideCommentOperation?.requestBody?.content?.['application/json']?.schema;
const hideCommentResponseSchema = hideCommentOperation?.responses?.['200']?.content?.['application/json']?.schema;
const listNotificationsOperation = contract.paths?.[notificationsPath]?.get;
const listNotificationsResponseSchema = listNotificationsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const markNotificationReadOperation = contract.paths?.[notificationReadPath]?.post;
const markNotificationReadResponseSchema = markNotificationReadOperation?.responses?.['200']?.content?.['application/json']?.schema;
const markNotificationsReadBatchOperation = contract.paths?.[notificationsReadBatchPath]?.post;
const markNotificationsReadBatchRequestSchema = markNotificationsReadBatchOperation?.requestBody?.content?.['application/json']?.schema;
const markNotificationsReadBatchResponseSchema = markNotificationsReadBatchOperation?.responses?.['200']?.content?.['application/json']?.schema;

if (!operation || responseSchema?.$ref !== '#/components/schemas/HealthResponse') {
  throw new Error(`Expected GET ${healthPath} with a HealthResponse schema in ${contractPath}`);
}

if (!homeOperation || homeResponseSchema?.$ref !== '#/components/schemas/LessonsLearnedHomeResponse') {
  throw new Error(`Expected GET ${homePath} with a LessonsLearnedHomeResponse schema in ${contractPath}`);
}

if (!lessonsOperation || lessonsResponseSchema?.type !== 'array' ||
  lessonsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${lessonsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!createLessonOperation || createLessonRequestSchema?.$ref !== '#/components/schemas/CreateLessonRequest' ||
  createLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${lessonsPath} with CreateLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!projectsOperation || projectsResponseSchema?.type !== 'array' ||
  projectsResponseSchema.items?.$ref !== '#/components/schemas/LessonProjectResponse') {
  throw new Error(`Expected GET ${projectsPath} with an array of LessonProjectResponse in ${contractPath}`);
}

if (!submissionsOperation || submissionsResponseSchema?.type !== 'array' ||
  submissionsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${submissionsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!pmoDraftsOperation || pmoDraftsResponseSchema?.type !== 'array' ||
  pmoDraftsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${pmoDraftsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!pmoDashboardOperation || pmoDashboardResponseSchema?.$ref !== '#/components/schemas/PmoDashboardResponse') {
  throw new Error(`Expected GET ${pmoDashboardPath} with PmoDashboardResponse in ${contractPath}`);
}

if (!profilesOperation || profilesResponseSchema?.type !== 'array' ||
  profilesResponseSchema.items?.$ref !== '#/components/schemas/ProfileSummaryResponse') {
  throw new Error(`Expected GET ${profilesPath} with an array of ProfileSummaryResponse in ${contractPath}`);
}

if (!profileDetailOperation || profileDetailResponseSchema?.$ref !== '#/components/schemas/ContributorProfileResponse') {
  throw new Error(`Expected GET ${profileDetailPath} with ContributorProfileResponse in ${contractPath}`);
}

if (!rankingsOperation || rankingsResponseSchema?.$ref !== '#/components/schemas/RankingsResponse') {
  throw new Error(`Expected GET ${rankingsPath} with RankingsResponse in ${contractPath}`);
}

if (!evaluationQueueResponseSchema?.oneOf?.some((schema) => schema.$ref === '#/components/schemas/LessonPage')) {
  throw new Error('Expected a LessonPage response in the Lessons Learned OpenAPI contract.');
}

if (!libraryResponseSchema?.oneOf?.some((schema) => schema.$ref === '#/components/schemas/LessonLibraryPage') ||
  !libraryResponseSchema?.oneOf?.some((schema) => schema.type === 'array' &&
    schema.items?.$ref === '#/components/schemas/LessonLibraryResponse')) {
  throw new Error('Expected a LessonLibraryPage or LessonLibraryResponse array in the Lessons Learned OpenAPI contract.');
}

if (!libraryProjectsOperation || libraryProjectsResponseSchema?.type !== 'array' ||
  libraryProjectsResponseSchema.items?.$ref !== '#/components/schemas/LessonProjectResponse') {
  throw new Error(`Expected GET ${libraryProjectsPath} with an array of LessonProjectResponse in ${contractPath}`);
}

if (!libraryDetailOperation || libraryDetailResponseSchema?.$ref !== '#/components/schemas/LessonDetailsResponse') {
  throw new Error(`Expected GET ${libraryDetailPath} with LessonDetailsResponse in ${contractPath}`);
}

if (!libraryViewOperation || libraryViewRequestSchema?.$ref !== '#/components/schemas/RecordLibraryViewRequest' ||
  libraryViewResponseSchema?.$ref !== '#/components/schemas/RecordLessonLibraryViewResponse') {
  throw new Error(`Expected POST ${libraryViewPath} with RecordLibraryViewRequest and RecordLessonLibraryViewResponse in ${contractPath}`);
}

if (!detailsOperation || detailsResponseSchema?.$ref !== '#/components/schemas/LessonDetailsResponse') {
  throw new Error(`Expected GET ${draftPath} with LessonDetailsResponse in ${contractPath}`);
}

if (!updateLessonOperation || updateLessonRequestSchema?.$ref !== '#/components/schemas/UpdateLessonDraftRequest' ||
  updateLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected PATCH ${draftPath} with UpdateLessonDraftRequest and LessonDraftResponse in ${contractPath}`);
}

if (!submitLessonOperation || submitLessonRequestSchema?.$ref !== '#/components/schemas/SubmitLessonRequest' ||
  submitLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${submitPath} with SubmitLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!returnLessonOperation || returnLessonRequestSchema?.$ref !== '#/components/schemas/ReturnLessonRequest' ||
  returnLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${returnPath} with ReturnLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!cancelLessonOperation || cancelLessonRequestSchema?.$ref !== '#/components/schemas/CancelLessonRequest' ||
  cancelLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${cancelPath} with CancelLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!approveLessonOperation || approveLessonRequestSchema?.$ref !== '#/components/schemas/ApproveLessonRequest' ||
  approveLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${approvePath} with ApproveLessonRequest and LessonDraftResponse in ${contractPath}`);
}
if (!rejectLessonOperation || rejectLessonRequestSchema?.$ref !== '#/components/schemas/RejectLessonRequest' ||
  rejectLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${rejectPath} with RejectLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!closeLessonOperation || closeLessonRequestSchema?.$ref !== '#/components/schemas/CloseLessonRequest' ||
  closeLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${closePath} with CloseLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!castVoteOperation || castVoteResponseSchema?.$ref !== '#/components/schemas/LessonVoteResponse') {
  throw new Error(`Expected PUT ${votePath} with LessonVoteResponse in ${contractPath}`);
}

if (!removeVoteOperation || removeVoteResponseSchema?.$ref !== '#/components/schemas/LessonVoteResponse') {
  throw new Error(`Expected DELETE ${votePath} with LessonVoteResponse in ${contractPath}`);
}

if (!listCommentsOperation || listCommentsResponseSchema?.$ref !== '#/components/schemas/LessonCommentPageResponse') {
  throw new Error(`Expected GET ${commentsPath} with LessonCommentPageResponse in ${contractPath}`);
}

if (!createCommentOperation || createCommentRequestSchema?.$ref !== '#/components/schemas/CreateLessonCommentRequest' ||
  createCommentResponseSchema?.$ref !== '#/components/schemas/LessonCommentThreadResponse') {
  throw new Error(`Expected POST ${commentsPath} with CreateLessonCommentRequest and LessonCommentThreadResponse in ${contractPath}`);
}

if (!createReplyOperation || createReplyRequestSchema?.$ref !== '#/components/schemas/CreateLessonCommentRequest' ||
  createReplyResponseSchema?.$ref !== '#/components/schemas/LessonCommentItemResponse') {
  throw new Error(`Expected POST ${commentRepliesPath} with CreateLessonCommentRequest and LessonCommentItemResponse in ${contractPath}`);
}

if (!hideCommentOperation || hideCommentRequestSchema?.$ref !== '#/components/schemas/HideLessonCommentRequest' ||
  hideCommentResponseSchema?.$ref !== '#/components/schemas/LessonCommentItemResponse') {
  throw new Error(`Expected POST ${commentHidePath} with HideLessonCommentRequest and LessonCommentItemResponse in ${contractPath}`);
}

if (!listNotificationsOperation || listNotificationsResponseSchema?.$ref !== '#/components/schemas/LessonNotificationPageResponse') {
  throw new Error(`Expected GET ${notificationsPath} with LessonNotificationPageResponse in ${contractPath}`);
}

if (!markNotificationReadOperation || markNotificationReadResponseSchema?.$ref !== '#/components/schemas/MarkNotificationReadResponse') {
  throw new Error(`Expected POST ${notificationReadPath} with MarkNotificationReadResponse in ${contractPath}`);
}

if (!markNotificationsReadBatchOperation || markNotificationsReadBatchRequestSchema?.$ref !== '#/components/schemas/MarkNotificationsReadBatchRequest' ||
  markNotificationsReadBatchResponseSchema?.$ref !== '#/components/schemas/MarkNotificationsReadBatchResponse') {
  throw new Error(`Expected POST ${notificationsReadBatchPath} with MarkNotificationsReadBatchRequest and MarkNotificationsReadBatchResponse in ${contractPath}`);
}

const generatedClient = `/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { components, paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '${healthPath}' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '${homePath}' satisfies keyof paths;
export const LESSONS_LEARNED_LESSONS_PATH = '${lessonsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PROJECTS_PATH = '${projectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMISSIONS_PATH = '${submissionsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PMO_DRAFTS_PATH = '${pmoDraftsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PMO_DASHBOARD_PATH = '${pmoDashboardPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PROFILES_PATH = '${profilesPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PROFILE_DETAIL_PATH = '${profileDetailPath}' satisfies keyof paths;
export const LESSONS_LEARNED_RANKINGS_PATH = '${rankingsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_QUEUE_PATH = '${evaluationQueuePath}' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_PROJECTS_PATH = '${evaluationProjectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_PATH = '${libraryPath}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_DETAIL_PATH = '${libraryDetailPath}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_VIEW_PATH = '${libraryViewPath}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_PROJECTS_PATH = '${libraryProjectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_DRAFT_PATH = '${draftPath}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMIT_PATH = '${submitPath}' satisfies keyof paths;
export const LESSONS_LEARNED_RETURN_PATH = '${returnPath}' satisfies keyof paths;
export const LESSONS_LEARNED_CANCEL_PATH = '${cancelPath}' satisfies keyof paths;
export const LESSONS_LEARNED_APPROVE_PATH = '${approvePath}' satisfies keyof paths;
export const LESSONS_LEARNED_REJECT_PATH = '${rejectPath}' satisfies keyof paths;
export const LESSONS_LEARNED_CLOSE_PATH = '${closePath}' satisfies keyof paths;
export const LESSONS_LEARNED_VOTE_PATH = '${votePath}' satisfies keyof paths;
export const LESSONS_LEARNED_COMMENTS_PATH = '${commentsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_COMMENT_REPLIES_PATH = '${commentRepliesPath}' satisfies keyof paths;
export const LESSONS_LEARNED_COMMENT_HIDE_PATH = '${commentHidePath}' satisfies keyof paths;
export const LESSONS_LEARNED_NOTIFICATIONS_PATH = '${notificationsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_NOTIFICATION_READ_PATH = '${notificationReadPath}' satisfies keyof paths;
export const LESSONS_LEARNED_NOTIFICATIONS_READ_BATCH_PATH = '${notificationsReadBatchPath}' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonDraft = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type LessonDetails = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonHistoryEvent = LessonDetails['history'][number];
export type LessonSubmissionsFilters = NonNullable<paths[typeof LESSONS_LEARNED_SUBMISSIONS_PATH]['get']['parameters']['query']>;
export type PmoDraftsFilters = NonNullable<paths[typeof LESSONS_LEARNED_PMO_DRAFTS_PATH]['get']['parameters']['query']>;
export type PmoDashboardFilters = NonNullable<paths[typeof LESSONS_LEARNED_PMO_DASHBOARD_PATH]['get']['parameters']['query']>;
export type PmoDashboardCard = NonNullable<PmoDashboardFilters['card']>;
export type PmoDashboardSort = NonNullable<PmoDashboardFilters['sort']>;
export type PmoDashboardResponse = paths[typeof LESSONS_LEARNED_PMO_DASHBOARD_PATH]['get']['responses'][200]['content']['application/json'];
export type PmoDashboardSummary = PmoDashboardResponse['summary'];
export type PmoDashboardLesson = PmoDashboardResponse['items'][number];
export type ProfileSearchFilters = NonNullable<paths[typeof LESSONS_LEARNED_PROFILES_PATH]['get']['parameters']['query']>;
export type ProfileSummary = paths[typeof LESSONS_LEARNED_PROFILES_PATH]['get']['responses'][200]['content']['application/json'][number];
export type ContributorProfileFilters = NonNullable<paths[typeof LESSONS_LEARNED_PROFILE_DETAIL_PATH]['get']['parameters']['query']>;
export type ContributorProfileSort = NonNullable<ContributorProfileFilters['sort']>;
export type ContributorProfileResponse = paths[typeof LESSONS_LEARNED_PROFILE_DETAIL_PATH]['get']['responses'][200]['content']['application/json'];
export type RankingsResponse = paths[typeof LESSONS_LEARNED_RANKINGS_PATH]['get']['responses'][200]['content']['application/json'];
export type RankedLesson = RankingsResponse['mostVotedLessons'][number];
export type RankedContributor = RankingsResponse['topContributors'][number];
export type LessonPage = components['schemas']['LessonPage'];
export type LibraryLesson = components['schemas']['LessonLibraryResponse'];
export type LibraryPage = components['schemas']['LessonLibraryPage'];
type PageParameters = { paged: 'true'; cursor?: string };
export type LessonsLibraryFilters = Omit<NonNullable<paths[typeof LESSONS_LEARNED_LIBRARY_PATH]['get']['parameters']['query']>, 'paged' | 'cursor' | 'limit'>;
type LibraryPageParameters = PageParameters & LessonsLibraryFilters;
export type PmoEvaluationQueueFilters = Omit<NonNullable<paths[typeof LESSONS_LEARNED_EVALUATION_QUEUE_PATH]['get']['parameters']['query']>, 'paged' | 'cursor' | 'limit'>;
export type CreateLessonDraftBody = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['post']['requestBody']['content']['application/json'];
export type LessonProject = paths[typeof LESSONS_LEARNED_PROJECTS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type UpdateLessonDraftBody = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['patch']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type SubmitLessonBody = paths[typeof LESSONS_LEARNED_SUBMIT_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type ReturnLessonBody = paths[typeof LESSONS_LEARNED_RETURN_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type CancelLessonBody = paths[typeof LESSONS_LEARNED_CANCEL_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type ApproveLessonBody = paths[typeof LESSONS_LEARNED_APPROVE_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type RejectLessonBody = paths[typeof LESSONS_LEARNED_REJECT_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type CloseLessonBody = paths[typeof LESSONS_LEARNED_CLOSE_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type RecordLibraryViewBody = paths[typeof LESSONS_LEARNED_LIBRARY_VIEW_PATH]['post']['requestBody']['content']['application/json'];
export type RecordLibraryViewResponse = paths[typeof LESSONS_LEARNED_LIBRARY_VIEW_PATH]['post']['responses'][200]['content']['application/json'];
export type LessonVoteResponse = paths[typeof LESSONS_LEARNED_VOTE_PATH]['put']['responses'][200]['content']['application/json'];
export type LessonCommentModeration = components['schemas']['LessonCommentModerationResponse'];
export type LessonCommentItem = components['schemas']['LessonCommentItemResponse'];
export type LessonCommentThread = components['schemas']['LessonCommentThreadResponse'];
export type LessonCommentPage = components['schemas']['LessonCommentPageResponse'];
export type LessonCommentsQuery = NonNullable<paths[typeof LESSONS_LEARNED_COMMENTS_PATH]['get']['parameters']['query']>;
export type CreateLessonCommentBody = paths[typeof LESSONS_LEARNED_COMMENTS_PATH]['post']['requestBody']['content']['application/json'];
export type HideLessonCommentBody = paths[typeof LESSONS_LEARNED_COMMENT_HIDE_PATH]['post']['requestBody']['content']['application/json'];
export type LessonNotificationItem = components['schemas']['LessonNotificationItemResponse'];
export type LessonNotificationEventType = LessonNotificationItem['eventType'];
export type LessonNotificationPage = components['schemas']['LessonNotificationPageResponse'];
export type LessonNotificationsQuery = NonNullable<paths[typeof LESSONS_LEARNED_NOTIFICATIONS_PATH]['get']['parameters']['query']>;
export type MarkNotificationReadResponse = components['schemas']['MarkNotificationReadResponse'];
export type MarkNotificationsReadBatchBody = paths[typeof LESSONS_LEARNED_NOTIFICATIONS_READ_BATCH_PATH]['post']['requestBody']['content']['application/json'];
export type MarkNotificationsReadBatchResponse = components['schemas']['MarkNotificationsReadBatchResponse'];

export const LESSONS_LEARNED_API_TIMEOUT_MS = 5_000;

export const api = axios.create();
api.defaults.headers.common.Accept = 'application/json, application/problem+json';

api.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response &&
    String(error.response.headers['content-type']).startsWith('application/problem+json')) {
    const problem = error.response.data as Partial<components['schemas']['LessonProblem']>;
    const fieldErrors = Object.fromEntries((problem.errors ?? []).map(({ path, message }) => [path, message]));
    error.response.data = {
      ...problem,
      code: problem.code === 'PRECONDITION_FAILED' ? 'STALE_LESSON_VERSION' : problem.code,
      message: problem.detail,
      ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}),
    };
  }
  return Promise.reject(error);
});

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await api.get<HealthResponse>(LESSONS_LEARNED_HEALTH_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
  });

  if (data.status !== 'ok') {
    throw new Error('The Lessons Learned API is unavailable.');
  }

  return data;
}

export async function getHome(localUserId: string): Promise<HomeResponse> {
  const { data } = await api.get<HomeResponse>(LESSONS_LEARNED_HOME_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getMyOpenDrafts(localUserId: string): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_LESSONS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getMySubmissions(localUserId: string, filters: LessonSubmissionsFilters = {}): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_SUBMISSIONS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export async function getPmoDrafts(localUserId: string, filters: PmoDraftsFilters = {}): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_PMO_DRAFTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export async function getPmoDashboard(localUserId: string, filters: PmoDashboardFilters = {}): Promise<PmoDashboardResponse> {
  const { data } = await api.get<PmoDashboardResponse>(LESSONS_LEARNED_PMO_DASHBOARD_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export async function getProfiles(localUserId: string, filters: ProfileSearchFilters = {}): Promise<ProfileSummary[]> {
  const { data } = await api.get<ProfileSummary[]>(LESSONS_LEARNED_PROFILES_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export async function getContributorProfile(
  localUserId: string,
  userId: string,
  filters: ContributorProfileFilters = {},
): Promise<ContributorProfileResponse> {
  const { data } = await api.get<ContributorProfileResponse>(
    LESSONS_LEARNED_PROFILE_DETAIL_PATH.replace('{userId}', encodeURIComponent(userId)),
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
      params: filters,
    },
  );

  return data;
}

export async function getRankings(localUserId: string): Promise<RankingsResponse> {
  const { data } = await api.get<RankingsResponse>(LESSONS_LEARNED_RANKINGS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export function getPmoEvaluationQueue(localUserId: string, filters?: PmoEvaluationQueueFilters): Promise<LessonDraft[]>;
export function getPmoEvaluationQueue(localUserId: string, filters: PmoEvaluationQueueFilters, page: PageParameters): Promise<LessonPage | LessonDraft[]>;
export async function getPmoEvaluationQueue(
  localUserId: string,
  filters: PmoEvaluationQueueFilters = {},
  page?: PageParameters,
): Promise<LessonPage | LessonDraft[]> {
  const { data } = await api.get<LessonPage | LessonDraft[]>(LESSONS_LEARNED_EVALUATION_QUEUE_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: page ? { ...filters, ...page } : filters,
  });

  return data;
}

export async function getEvaluationProjectSnapshots(localUserId: string, signal?: AbortSignal): Promise<LessonProject[]> {
  const projects: LessonProject[] = [];
  let cursor: string | undefined;
  try {
    do {
      const { data } = await api.get<LessonProject[] | components['schemas']['LessonProjectPage']>(
        LESSONS_LEARNED_EVALUATION_PROJECTS_PATH, {
          timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
          headers: { 'X-PMO-Local-User-ID': localUserId },
          params: { paged: 'true', cursor },
          signal,
        },
      );
      if (Array.isArray(data)) return data;
      projects.push(...data.items);
      cursor = data.page.nextCursor ?? undefined;
    } while (cursor);
    return projects;
  } catch (error) {
    if (cursor || !axios.isAxiosError(error) || error.response?.status !== 404) throw error;
    const legacy = await getPmoEvaluationQueue(localUserId);
    return legacy.flatMap(({ projectId, projectName }) =>
      projectId && projectName ? [{ id: projectId, name: projectName }] : [],
    );
  }
}

export function getLibrary(localUserId: string): Promise<LibraryLesson[]>;
export function getLibrary(localUserId: string, page: LibraryPageParameters): Promise<LibraryPage | LibraryLesson[]>;
export async function getLibrary(localUserId: string, page?: LibraryPageParameters): Promise<LibraryPage | LibraryLesson[]> {
  const { data } = await api.get<LibraryPage | LibraryLesson[]>(LESSONS_LEARNED_LIBRARY_PATH, {
    ...(page ? { params: page } : {}),
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLibraryProjectSnapshots(localUserId: string): Promise<LessonProject[]> {
  const { data } = await api.get<LessonProject[]>(LESSONS_LEARNED_LIBRARY_PROJECTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLibraryLessonDetails(localUserId: string, lessonId: number): Promise<LessonDetails> {
  const { data } = await api.get<LessonDetails>(LESSONS_LEARNED_LIBRARY_DETAIL_PATH.replace('{id}', String(lessonId)), {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function recordLibraryView(
  localUserId: string,
  lessonId: number,
  input: RecordLibraryViewBody,
): Promise<RecordLibraryViewResponse> {
  const { data } = await api.post<RecordLibraryViewResponse>(
    LESSONS_LEARNED_LIBRARY_VIEW_PATH.replace('{id}', String(lessonId)),
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function getLessonDetails(localUserId: string, lessonId: number): Promise<LessonDetails> {
  const { data } = await api.get<LessonDetails>(LESSONS_LEARNED_DRAFT_PATH.replace('{id}', String(lessonId)), {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function createLessonDraft(
  localUserId: string,
  titleOrInput: string | CreateLessonDraftBody,
): Promise<LessonDraft> {
  const body: CreateLessonDraftBody = typeof titleOrInput === 'string' ? { title: titleOrInput } : titleOrInput;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_LESSONS_PATH, body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLessonProjects(localUserId: string): Promise<LessonProject[]> {
  const { data } = await api.get<LessonProject[]>(LESSONS_LEARNED_PROJECTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function updateLessonDraft(
  localUserId: string,
  lessonId: number,
  input: UpdateLessonDraftBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.patch<LessonDraft>(LESSONS_LEARNED_DRAFT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function submitLesson(
  localUserId: string,
  lessonId: number,
  input: SubmitLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_SUBMIT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function returnLesson(
  localUserId: string,
  lessonId: number,
  input: ReturnLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_RETURN_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function cancelLesson(
  localUserId: string,
  lessonId: number,
  input: CancelLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_CANCEL_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function approveLesson(
  localUserId: string,
  lessonId: number,
  input: ApproveLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_APPROVE_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });
  return data;
}

export async function rejectLesson(
  localUserId: string,
  lessonId: number,
  input: RejectLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_REJECT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function closeLesson(
  localUserId: string,
  lessonId: number,
  input: CloseLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_CLOSE_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function castLessonVote(
  localUserId: string,
  lessonId: number,
): Promise<LessonVoteResponse> {
  const { data } = await api.put<LessonVoteResponse>(
    LESSONS_LEARNED_VOTE_PATH.replace('{id}', String(lessonId)),
    undefined,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function removeLessonVote(
  localUserId: string,
  lessonId: number,
): Promise<LessonVoteResponse> {
  const { data } = await api.delete<LessonVoteResponse>(
    LESSONS_LEARNED_VOTE_PATH.replace('{id}', String(lessonId)),
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function getLessonComments(
  localUserId: string,
  lessonId: number,
  query: LessonCommentsQuery = {},
): Promise<LessonCommentPage> {
  const { data } = await api.get<LessonCommentPage>(
    LESSONS_LEARNED_COMMENTS_PATH.replace('{id}', String(lessonId)),
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
      params: query,
    },
  );

  return data;
}

export async function createLessonComment(
  localUserId: string,
  lessonId: number,
  input: CreateLessonCommentBody,
): Promise<LessonCommentThread> {
  const { data } = await api.post<LessonCommentThread>(
    LESSONS_LEARNED_COMMENTS_PATH.replace('{id}', String(lessonId)),
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function createLessonCommentReply(
  localUserId: string,
  lessonId: number,
  commentId: number,
  input: CreateLessonCommentBody,
): Promise<LessonCommentItem> {
  const { data } = await api.post<LessonCommentItem>(
    LESSONS_LEARNED_COMMENT_REPLIES_PATH
      .replace('{id}', String(lessonId))
      .replace('{commentId}', String(commentId)),
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function hideLessonComment(
  localUserId: string,
  lessonId: number,
  commentId: number,
  input: HideLessonCommentBody,
): Promise<LessonCommentItem> {
  const { data } = await api.post<LessonCommentItem>(
    LESSONS_LEARNED_COMMENT_HIDE_PATH
      .replace('{id}', String(lessonId))
      .replace('{commentId}', String(commentId)),
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function getNotifications(
  localUserId: string,
  query: LessonNotificationsQuery = {},
  signal?: AbortSignal,
): Promise<LessonNotificationPage> {
  const { data } = await api.get<LessonNotificationPage>(
    LESSONS_LEARNED_NOTIFICATIONS_PATH,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
      params: query,
      signal,
    },
  );

  return data;
}

export async function markNotificationAsRead(
  localUserId: string,
  notificationId: number,
): Promise<MarkNotificationReadResponse> {
  const { data } = await api.post<MarkNotificationReadResponse>(
    LESSONS_LEARNED_NOTIFICATION_READ_PATH.replace('{id}', String(notificationId)),
    undefined,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function markNotificationsReadBatch(
  localUserId: string,
  input: MarkNotificationsReadBatchBody,
): Promise<MarkNotificationsReadBatchResponse> {
  const { data } = await api.post<MarkNotificationsReadBatchResponse>(
    LESSONS_LEARNED_NOTIFICATIONS_READ_BATCH_PATH,
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}
`;

await writeFile(outputPath, generatedClient, 'utf8');
