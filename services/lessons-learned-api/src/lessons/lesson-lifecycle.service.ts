import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
  Optional, ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LocalAccessService, type LocalProfile } from '../local-access.service';
import type { ApproveLessonRequest } from './approve-lesson-request.dto';
import type { CancelLessonRequest } from './cancel-lesson-request.dto';
import type { CloseLessonRequest } from './close-lesson-request.dto';
import type { LessonStatus } from './lesson-domain.constants';
import { LessonHistory } from './lesson-history.entity';
import type { LessonNotificationEventType } from './lesson-notification.entity';
import { formatNotificationSnippet, LessonNotificationsService } from './lesson-notifications.service';
import { toLessonDraftResponse } from './lesson-read-model';
import type { LessonDraftResponse } from './lesson-response.dto';
import { evaluationCompletenessErrors, validateProjectSelection } from './lesson-validation';
import { checkLessonIfMatch, staleLessonVersionConflict } from './lesson-version';
import { Lesson } from './lesson.entity';
import { ProjectCatalogService } from './project-catalog.service';
import type { RejectLessonRequest } from './reject-lesson-request.dto';
import type { ReturnLessonRequest } from './return-lesson-request.dto';
import type { SubmitLessonRequest } from './submit-lesson-request.dto';

type TransitionRule = {
  eventType: Exclude<LessonHistory['eventType'], 'Created'>;
  from: LessonStatus;
  to: LessonStatus;
  conflict: { code: string; message: string };
  authorAccess?: 'author-only' | 'author-or-pmo';
};

const transitionRules = {
  cancel: {
    eventType: 'Cancelled', from: 'Open', to: 'Archived', authorAccess: 'author-or-pmo',
    conflict: { code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be cancelled.' },
  },
  approve: {
    eventType: 'Approved', from: 'PMOEvaluation', to: 'Approved',
    conflict: {
      code: 'LESSON_NOT_AWAITING_EVALUATION',
      message: 'This lesson is no longer awaiting PMO evaluation. Reload the current queue before deciding again.',
    },
  },
  reject: {
    eventType: 'Rejected', from: 'PMOEvaluation', to: 'Archived',
    conflict: { code: 'LESSON_NOT_AWAITING_EVALUATION', message: 'Only lessons awaiting PMO evaluation can be rejected.' },
  },
  close: {
    eventType: 'Closed', from: 'Approved', to: 'Closed',
    conflict: {
      code: 'LESSON_NOT_APPROVED',
      message: 'This lesson is no longer Approved. Reload the current version before deciding again.',
    },
  },
  submit: {
    eventType: 'Submitted', from: 'Open', to: 'PMOEvaluation', authorAccess: 'author-only',
    conflict: { code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be submitted.' },
  },
  return: {
    eventType: 'Returned', from: 'PMOEvaluation', to: 'Open',
    conflict: {
      code: 'LESSON_NOT_AWAITING_EVALUATION',
      message: 'This lesson is no longer awaiting evaluation. Reload the current version before deciding.',
    },
  },
} satisfies Record<string, TransitionRule>;

type TransitionTarget = {
  lessonId: number;
  profile: LocalProfile;
  version: number;
  ifMatch?: string;
};

type CommittedTransition = { lesson: Lesson; historyEntry: LessonHistory };

@Injectable()
export class LessonLifecycleService {
  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Inject(ProjectCatalogService) private readonly projectCatalog: ProjectCatalogService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
    @Optional() @Inject(LessonNotificationsService) private readonly notifications?: LessonNotificationsService,
  ) {}

  async cancelOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: CancelLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const { lesson } = await this.runTransition(
      this.requireDataSource(), { lessonId, profile, version: input.version, ifMatch }, transitionRules.cancel,
      () => {
        const reason = input.reason.trim();
        if (!reason) {
          const message = 'Enter a cancellation reason.';
          throw new BadRequestException({
            code: 'INVALID_LESSON_CANCELLATION',
            message,
            fieldErrors: { reason: message },
          });
        }
        return reason;
      },
    );
    return toLessonDraftResponse(lesson);
  }

  async approveEvaluatedLesson(
    localUserId: string | undefined,
    lessonId: number,
    input: ApproveLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to approve lessons.');
    }
    const result = await this.runTransition(
      this.requireDataSource(), { lessonId, profile, version: input.version, ifMatch }, transitionRules.approve,
      (lesson) => {
        this.validateLessonForApproval(lesson);
        lesson.approvedAt = new Date();
      },
    );
    await this.notifyAuthor(result, profile, 'LESSON_APPROVED', `${profile.displayName} approved your lesson.`);
    return toLessonDraftResponse(result.lesson);
  }

  async rejectEvaluation(
    localUserId: string | undefined,
    lessonId: number,
    input: RejectLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to reject a lesson.');
    }
    const dataSource = this.requireDataSource();
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) {
      const message = 'Enter a rejection reason of 1 to 1,000 characters.';
      throw new BadRequestException({
        code: 'INVALID_LESSON_REJECTION',
        message,
        fieldErrors: { reason: message },
      });
    }
    const result = await this.runTransition(
      dataSource, { lessonId, profile, version: input.version, ifMatch }, transitionRules.reject, () => reason,
    );
    await this.notifyAuthor(result, profile, 'LESSON_REJECTED',
      `${profile.displayName} rejected your lesson: ${formatNotificationSnippet(reason)}`);
    return toLessonDraftResponse(result.lesson);
  }

  async closeApprovedLesson(
    localUserId: string | undefined,
    lessonId: number,
    input: CloseLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to close lessons.');
    }
    const { lesson } = await this.runTransition(
      this.requireDataSource(), { lessonId, profile, version: input.version, ifMatch }, transitionRules.close,
    );
    return toLessonDraftResponse(lesson);
  }

  async submitOwnOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: SubmitLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const { lesson } = await this.runTransition(
      this.requireDataSource(), { lessonId, profile, version: input.version, ifMatch }, transitionRules.submit,
      (current) => this.applySubmissionFields(current, input),
    );
    return toLessonDraftResponse(lesson);
  }

  async returnForChanges(
    localUserId: string | undefined,
    lessonId: number,
    input: ReturnLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to return a lesson for changes.');
    }
    const guidance = typeof input.guidance === 'string' ? input.guidance.trim() : '';
    const result = await this.runTransition(
      this.requireDataSource(), { lessonId, profile, version: input.version, ifMatch }, transitionRules.return,
      () => {
        if (!guidance || input.guidance.length > 1000) {
          const message = !guidance ? 'Enter guidance for the author.' : 'Guidance must be 1000 characters or fewer.';
          throw new BadRequestException({
            code: 'INVALID_LESSON_RETURN',
            message,
            fieldErrors: { guidance: message },
          });
        }
        return guidance;
      },
    );
    await this.notifyAuthor(result, profile, 'LESSON_RETURNED',
      `${profile.displayName} returned your lesson for changes: ${formatNotificationSnippet(guidance)}`);
    return { ...toLessonDraftResponse(result.lesson), latestReviewGuidance: guidance };
  }

  private runTransition(
    dataSource: DataSource,
    { lessonId, profile, version, ifMatch }: TransitionTarget,
    rule: TransitionRule,
    prepare?: (lesson: Lesson) => string | void,
  ): Promise<CommittedTransition> {
    return dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: rule.authorAccess === 'author-only' ? { id: lessonId, authorId: profile.id } : { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || (rule.authorAccess === 'author-or-pmo'
        && profile.role !== 'LESSONS_MODERATOR' && current.authorId !== profile.id)) {
        throw new NotFoundException('Lesson not found.');
      }

      // Preserve conflict precedence for both conditional and legacy requests.
      await checkLessonIfMatch(ifMatch, version, current, profile, manager, this.localAccess);
      if (current.status !== rule.from) throw new ConflictException(rule.conflict);
      if (current.version !== version) throw staleLessonVersionConflict();
      const reason = prepare?.(current);

      current.status = rule.to;
      current.updatedBy = profile.id;
      current.version += 1;
      const lesson = await lessons.save(current);
      const history = manager.getRepository(LessonHistory);
      const historyEntry = await history.save(history.create({
        lessonId: lesson.id,
        actorId: profile.id,
        eventType: rule.eventType,
        previousStatus: rule.from,
        newStatus: rule.to,
        reason: reason ?? undefined,
      }));
      return { lesson, historyEntry };
    });
  }

  private async notifyAuthor(
    { lesson, historyEntry }: CommittedTransition,
    profile: LocalProfile,
    eventType: LessonNotificationEventType,
    summary: string,
  ): Promise<void> {
    await this.notifications?.recordNotification({
      recipientUserId: lesson.authorId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType,
      lessonId: lesson.id,
      lessonTitleSnapshot: lesson.title,
      summary,
      sourceEventKey: `history:${historyEntry.id}`,
    });
  }

  private applySubmissionFields(current: Lesson, input: SubmitLessonRequest): void {
    if (input.lessonType === 'Future Prevention' && !input.rootCause?.trim()) {
      throw new BadRequestException({
        code: 'INVALID_LESSON_SUBMISSION',
        message: 'Root cause is required for Future Prevention.',
        fieldErrors: { rootCause: 'Root cause is required for Future Prevention.' },
      });
    }
    const projectId = input.projectId === undefined ? current.projectId : input.projectId;
    const projectName = input.projectName === undefined ? current.projectName : input.projectName;
    try {
      validateProjectSelection(this.projectCatalog, current, projectId ?? null, projectName ?? null);
    } catch (error) {
      const response = error instanceof BadRequestException ? error.getResponse() : null;
      if (
        typeof response === 'object' && response !== null &&
        'code' in response && response.code === 'INVALID_PROJECT_SELECTION'
      ) {
        const message = 'Choose a current project or No project before submitting.';
        throw new BadRequestException({
          code: 'INVALID_LESSON_SUBMISSION',
          message,
          fieldErrors: { projectId: message },
        });
      }
      throw error;
    }

    current.title = input.title;
    current.projectId = projectId ?? null;
    current.projectName = projectName ?? null;
    current.projectCategory = input.projectCategory;
    current.projectPhase = input.projectPhase;
    current.situationObserved = input.situationObserved;
    current.rootCause = input.rootCause ?? null;
    current.lessonType = input.lessonType;
    current.impact = input.impact;
    current.recommendation = input.recommendation;
    current.applicability = input.applicability;
  }

  private validateLessonForApproval(lesson: Lesson): void {
    const fieldErrors = evaluationCompletenessErrors(lesson);
    if (lesson.projectCategory && !['Technology', 'Business', 'Infrastructure', 'Data'].includes(lesson.projectCategory)) {
      fieldErrors.projectCategory = 'Choose a project category.';
    }
    if (lesson.projectPhase && !['Initiation', 'Planning', 'Execution', 'Closure', 'Not Applicable'].includes(lesson.projectPhase)) {
      fieldErrors.projectPhase = 'Choose a project phase.';
    }
    if (lesson.lessonType && !['Future Prevention', 'Success to Repeat', 'Risk Avoided', 'Communication'].includes(lesson.lessonType)) {
      fieldErrors.lessonType = 'Choose a lesson type.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: 'INVALID_LESSON_APPROVAL',
        message: 'Complete the required lesson fields before approving.',
        fieldErrors,
      });
    }
    validateProjectSelection(this.projectCatalog, lesson, lesson.projectId, lesson.projectName);
  }

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
  }
}
