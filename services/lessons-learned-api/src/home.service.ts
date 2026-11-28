import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from './database/database.module';
import type {
  HomeHighlights,
  HomeLessonSummary,
  HomeNotificationsSummary,
  HomePrimaryAction,
  HomeShortcut,
  LessonsLearnedHomeResponse,
} from './home-response.dto';
import { LessonHistory } from './lessons/lesson-history.entity';
import { countUnreadNotifications } from './lessons/lesson-notification-store';
import { LessonNotification } from './lessons/lesson-notification.entity';
import { Lesson } from './lessons/lesson.entity';
import { LocalAccessService, type LessonsLearnedRole } from './local-access.service';

const CONTRIBUTOR_SHORTCUTS: HomeShortcut[] = [
  {
    id: 'create-lesson',
    label: 'Create lesson',
    description: 'Draft a new lesson learned for PMO review.',
    targetPage: 'create-lesson',
  },
  {
    id: 'my-submissions',
    label: 'My Submissions',
    description: 'Continue drafts, review returned lessons, and track status.',
    targetPage: 'my-submissions',
  },
  {
    id: 'library',
    label: 'Lessons Library',
    description: 'Search and explore published lessons.',
    targetPage: 'library',
  },
  {
    id: 'profiles',
    label: 'Profiles',
    description: 'Find contributors and review published contributions.',
    targetPage: 'profiles',
  },
];

const PMO_SHORTCUTS: HomeShortcut[] = [
  {
    id: 'evaluation-queue',
    label: 'PMO Review Queue',
    description: 'Evaluate submitted lessons in FIFO order.',
    targetPage: 'evaluation-queue',
  },
  {
    id: 'pmo-dashboard',
    label: 'PMO Dashboard',
    description: 'Monitor 30-day operational metrics and exceptions.',
    targetPage: 'pmo-dashboard',
  },
  {
    id: 'library',
    label: 'Lessons Library',
    description: 'Browse, vote on, and close published lessons.',
    targetPage: 'library',
  },
  {
    id: 'create-lesson',
    label: 'Create lesson',
    description: 'Register a new lesson learned directly.',
    targetPage: 'create-lesson',
  },
  {
    id: 'pmo-drafts',
    label: 'PMO Drafts',
    description: 'Manage open drafts authored by PMO moderators.',
    targetPage: 'pmo-drafts',
  },
  {
    id: 'my-submissions',
    label: 'My Submissions',
    description: 'Track lessons you authored.',
    targetPage: 'my-submissions',
  },
  {
    id: 'profiles',
    label: 'Profiles',
    description: 'Explore authorized contributor profiles.',
    targetPage: 'profiles',
  },
];

function getShortcutsForRole(role: LessonsLearnedRole): HomeShortcut[] {
  return role === 'LESSONS_MODERATOR'
    ? PMO_SHORTCUTS.map((shortcut) => ({ ...shortcut }))
    : CONTRIBUTOR_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
}

function buildPrimaryAction(params: {
  role: LessonsLearnedRole;
  returnedLessons: HomeLessonSummary[];
  returnedCount: number;
  nonReturnedOpenDrafts: HomeLessonSummary[];
  openDraftCount: number;
  pendingEvaluationLessons: HomeLessonSummary[];
  pendingEvaluationCount: number;
  recentWorkCount: number;
}): HomePrimaryAction {
  const {
    role,
    returnedLessons,
    returnedCount,
    nonReturnedOpenDrafts,
    openDraftCount,
    pendingEvaluationLessons,
    pendingEvaluationCount,
    recentWorkCount,
  } = params;

  if (role === 'LESSONS_MODERATOR') {
    if (pendingEvaluationCount > 0 && pendingEvaluationLessons.length > 0) {
      return {
        kind: 'evaluate-pending',
        label: 'Evaluate next lesson',
        description: pendingEvaluationCount === 1
          ? '1 lesson is awaiting PMO evaluation.'
          : `${pendingEvaluationCount} lessons are awaiting PMO evaluation.`,
        targetPage: 'evaluation-queue',
        lessonId: pendingEvaluationLessons[0].id,
      };
    }

    if (nonReturnedOpenDrafts.length > 0) {
      return {
        kind: 'continue-draft',
        label: 'Continue draft',
        description: openDraftCount === 1
          ? 'You have 1 open draft ready to complete.'
          : `You have ${openDraftCount} open drafts ready to complete.`,
        targetPage: 'pmo-drafts',
        lessonId: nonReturnedOpenDrafts[0].id,
      };
    }

    return {
      kind: 'explore-library',
      label: 'Explore Lessons Library',
      description: 'No lessons are awaiting evaluation. Browse published lessons or review the PMO Dashboard.',
      targetPage: 'library',
      lessonId: null,
    };
  }

  if (returnedCount > 0 && returnedLessons.length > 0) {
    return {
      kind: 'review-returned',
      label: 'Review returned lesson',
      description: returnedCount === 1
        ? '1 lesson was returned by the PMO and needs updates.'
        : `${returnedCount} lessons were returned by the PMO and need updates.`,
      targetPage: 'my-submissions',
      lessonId: returnedLessons[0].id,
    };
  }

  if (nonReturnedOpenDrafts.length > 0) {
    const draftCount = nonReturnedOpenDrafts.length;
    return {
      kind: 'continue-draft',
      label: 'Continue draft',
      description: draftCount === 1
        ? 'You have 1 open draft ready to complete and submit.'
        : `You have ${draftCount} open drafts ready to complete and submit.`,
      targetPage: 'my-submissions',
      lessonId: nonReturnedOpenDrafts[0].id,
    };
  }

  if (recentWorkCount === 0) {
    return {
      kind: 'create-lesson',
      label: 'Create lesson',
      description: 'Capture your first lesson learned to share with the team.',
      targetPage: 'create-lesson',
      lessonId: null,
    };
  }

  return {
    kind: 'explore-library',
    label: 'Explore Lessons Library',
    description: 'Browse published lessons from across the organization.',
    targetPage: 'library',
    lessonId: null,
  };
}

@Injectable()
export class HomeService {
  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async getHome(localUserId: string | undefined): Promise<LessonsLearnedHomeResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const shortcuts = getShortcutsForRole(profile.role);

    if (!this.dataSource) {
      return {
        profile: {
          id: profile.id,
          displayName: profile.displayName,
          role: profile.role,
        },
        navigation: [{ id: 'home', label: 'Home', current: true }],
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
        primaryAction: buildPrimaryAction({
          role: profile.role,
          returnedLessons: [],
          returnedCount: 0,
          nonReturnedOpenDrafts: [],
          openDraftCount: 0,
          pendingEvaluationLessons: [],
          pendingEvaluationCount: 0,
          recentWorkCount: 0,
        }),
        shortcuts,
      };
    }

    const displayNames = this.localAccess.getDisplayNames();
    const isPmo = profile.role === 'LESSONS_MODERATOR';

    const { notifications, recentWork, recentlyApprovedLessons, highlights, primaryAction } = await this.dataSource.transaction(
      'REPEATABLE READ',
      async (manager) => {
        // 1. Unread notifications strictly scoped to caller
        const unreadCount = await countUnreadNotifications(manager, profile.id);

        const unreadEntities = await manager
          .getRepository(LessonNotification)
          .createQueryBuilder('notification')
          .where('notification.recipient_user_id = :recipientUserId', { recipientUserId: profile.id })
          .andWhere('notification.read_at IS NULL')
          .orderBy('notification.created_at', 'DESC')
          .addOrderBy('notification.id', 'DESC')
          .limit(3)
          .getMany();

        const notificationsSummary: HomeNotificationsSummary = {
          unreadCount,
          items: unreadEntities.map((item) => ({
            id: item.id,
            eventType: item.eventType,
            actorUserId: item.actorUserId,
            actorDisplayName: item.actorDisplayName,
            lessonId: item.lessonId,
            lessonTitle: item.lessonTitleSnapshot,
            summary: item.summary,
            createdAt: item.createdAt,
            readAt: item.readAt,
            isRead: item.readAt !== null,
          })),
        };

        const lessonRepo = manager.getRepository(Lesson);
        const historyRepo = manager.getRepository(LessonHistory);

        // 2. Recent work (strictly caller's lessons for Contributor; latest across module for PMO)
        const recentQuery = lessonRepo.createQueryBuilder('lesson');
        if (!isPmo) {
          recentQuery.where('lesson.author_id = :authorId', { authorId: profile.id });
        }
        const recentEntities = await recentQuery
          .orderBy('lesson.updated_at', 'DESC')
          .addOrderBy('lesson.id', 'DESC')
          .limit(5)
          .getMany();

        // 3. Caller's own Open drafts (to separate returned lessons vs regular drafts)
        const myOpenEntities = await lessonRepo
          .createQueryBuilder('lesson')
          .where('lesson.author_id = :authorId', { authorId: profile.id })
          .andWhere('lesson.status = :status', { status: 'Open' })
          .orderBy('lesson.updated_at', 'DESC')
          .addOrderBy('lesson.id', 'DESC')
          .getMany();

        // 4. PMO pending evaluation queue (strictly PMO only)
        let pendingEvaluationCount = 0;
        let pendingEntities: Lesson[] = [];
        if (isPmo) {
          const pendingCountRows = await manager.query(
            `SELECT COUNT(*)::int AS count FROM lessons WHERE status = 'PMOEvaluation'`,
          ) as { count: number | string }[];
          pendingEvaluationCount = Number(pendingCountRows[0]?.count ?? 0);

          pendingEntities = await lessonRepo
            .createQueryBuilder('lesson')
            .where('lesson.status = :status', { status: 'PMOEvaluation' })
            .orderBy(
              `COALESCE((SELECT MAX(h.occurred_at) FROM lesson_history h WHERE h.lesson_id = lesson.id AND h.event_type = 'Submitted'), lesson.created_at)`,
              'ASC',
            )
            .addOrderBy('lesson.id', 'ASC')
            .limit(5)
            .getMany();
        }

        // 5. Latest lessons approved by PMO (published Approved/Closed lessons across the organization)
        const recentlyApprovedEntities = await lessonRepo
          .createQueryBuilder('lesson')
          .where('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
          .andWhere('lesson.approved_at IS NOT NULL')
          .orderBy('lesson.approved_at', 'DESC')
          .addOrderBy('lesson.id', 'DESC')
          .limit(6)
          .getMany();

        // Collect all Open lesson IDs across recentWork + myOpenEntities to resolve returned status & guidance
        const openLessonIds = Array.from(new Set(
          [...recentEntities, ...myOpenEntities]
            .filter((lesson) => lesson.status === 'Open')
            .map((lesson) => lesson.id),
        ));

        const latestReturnByLessonId = new Map<number, string | null>();
        if (openLessonIds.length > 0) {
          const returnEvents = await historyRepo
            .createQueryBuilder('history')
            .where('history.lesson_id IN (:...lessonIds)', { lessonIds: openLessonIds })
            .andWhere('history.event_type = :eventType', { eventType: 'Returned' })
            .orderBy('history.id', 'DESC')
            .getMany();
          for (const event of returnEvents) {
            if (!latestReturnByLessonId.has(event.lessonId)) {
              latestReturnByLessonId.set(event.lessonId, event.reason ?? null);
            }
          }
        }

        const toSummary = (lesson: Lesson): HomeLessonSummary => {
          const isReturned = lesson.status === 'Open' && latestReturnByLessonId.has(lesson.id);
          return {
            id: lesson.id,
            title: lesson.title,
            status: lesson.status,
            authorId: lesson.authorId,
            authorName: displayNames.get(lesson.authorId) ?? null,
            projectName: lesson.projectName,
            lessonType: lesson.lessonType,
            updatedAt: lesson.updatedAt,
            approvedAt: lesson.approvedAt,
            latestReviewGuidance: isReturned ? (latestReturnByLessonId.get(lesson.id) ?? null) : null,
            isReturned,
          };
        };

        const recentSummaries = recentEntities.map(toSummary);
        const recentlyApprovedSummaries = recentlyApprovedEntities.map(toSummary);
        const myOpenSummaries = myOpenEntities.map(toSummary);
        const allReturned = myOpenSummaries.filter((lesson) => lesson.isReturned);
        const nonReturnedOpenDrafts = myOpenSummaries.filter((lesson) => !lesson.isReturned);
        const returnedLessons = allReturned.slice(0, 5);
        const openDraftLessons = nonReturnedOpenDrafts.slice(0, 5);
        const pendingEvaluationLessons = pendingEntities.map(toSummary);

        const computedHighlights: HomeHighlights = {
          returnedCount: allReturned.length,
          returnedLessons,
          openDraftCount: myOpenSummaries.length,
          openDraftLessons,
          pendingEvaluationCount,
          pendingEvaluationLessons,
        };

        const computedPrimaryAction = buildPrimaryAction({
          role: profile.role,
          returnedLessons,
          returnedCount: allReturned.length,
          nonReturnedOpenDrafts,
          openDraftCount: myOpenSummaries.length,
          pendingEvaluationLessons,
          pendingEvaluationCount,
          recentWorkCount: recentSummaries.length,
        });

        return {
          notifications: notificationsSummary,
          recentWork: recentSummaries,
          recentlyApprovedLessons: recentlyApprovedSummaries,
          highlights: computedHighlights,
          primaryAction: computedPrimaryAction,
        };
      },
    );

    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        role: profile.role,
      },
      navigation: [{ id: 'home', label: 'Home', current: true }],
      notifications,
      recentWork,
      recentlyApprovedLessons,
      highlights,
      primaryAction,
      shortcuts,
    };
  }
}
