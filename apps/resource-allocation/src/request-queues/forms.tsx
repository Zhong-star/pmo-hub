import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { QueueSelections, RequestQueueItem } from '../requestQueueApi';
import { businessDate, businessDateAfterHours, normalizeWeeklyHours } from '../timeAndHours';
import { optionLabel, readRequestValue } from './shared';

interface ApprovalValues {
  personId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  explanation: string;
}

export type ApprovalDecision = {
  personId: string;
  resourceProfileId?: string;
  startDate?: string;
  endDate?: string;
  weeklyHours?: number;
  explanation?: string;
};

export interface ReferenceCorrectionValues {
  initiativeId?: string;
  groupId?: string;
  resourceProfileId?: string;
  personId?: string;
  reason: string;
}

interface RemovalValues {
  reason: string;
}

const readValue = readRequestValue;
export function ApprovalForm({
  item,
  selections,
  disabled: actionDisabled,
  onSubmit,
}: {
  item: RequestQueueItem;
  selections: QueueSelections;
  disabled: boolean;
  onSubmit: (approval: ApprovalDecision) => Promise<void>;
}) {
  const conditions = item.requestedConditions;
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm<ApprovalValues>({
    defaultValues: {
      personId: '',
      resourceProfileId: readValue(item, 'resourceProfileId'),
      startDate: readValue(item, 'startDate'),
      endDate: readValue(item, 'endDate'),
      weeklyHours: String(conditions.weeklyHours ?? ''),
      explanation: '',
    },
  });
  const disabled = actionDisabled || isSubmitting;
  const selectedProfileId = useWatch({ control, name: 'resourceProfileId' });
  const selectedStartDate = useWatch({ control, name: 'startDate' });
  const selectedEndDate = useWatch({ control, name: 'endDate' });
  const selectedWeeklyHours = useWatch({ control, name: 'weeklyHours' });
  const [startDates] = useState(() => ({
    today: businessDate(),
    afterAcceptanceWindow: businessDateAfterHours(72),
  }));
  const profileChanged = selectedProfileId !== conditions.resourceProfileId;
  const startDateChanged = selectedStartDate !== conditions.startDate;
  const endDateChanged = selectedEndDate !== conditions.endDate;
  const weeklyHours = normalizeWeeklyHours(selectedWeeklyHours ?? '').value;
  const weeklyHoursChanged = weeklyHours !== conditions.weeklyHours;
  const periodOrHoursChanged = startDateChanged || endDateChanged || weeklyHoursChanged;
  const requestedStartDatePassed = Boolean(conditions.startDate && conditions.startDate < startDates.today);
  const mustProposeChangedPeriod = requestedStartDatePassed || periodOrHoursChanged;
  const explanationRequired = profileChanged || mustProposeChangedPeriod;
  const minimumStartDate = mustProposeChangedPeriod ? startDates.afterAcceptanceWindow : startDates.today;
  const startDateValidationMessage = mustProposeChangedPeriod
    ? 'Propose a start date on or after the 72-hour acceptance deadline.'
    : 'The start date must be today or later.';
  const eligiblePeople = selections.people.filter((person) => person.groupId === conditions.groupId);
  const eligibleProfiles = selections.profiles.filter((profile) => profile.groupId === conditions.groupId);

  return (
    <form
      className="request-queue-action-form"
      aria-label={`Approve request ${item.id}`}
      noValidate
      onSubmit={handleSubmit((values) => onSubmit({
        personId: values.personId,
        ...(profileChanged ? { resourceProfileId: values.resourceProfileId } : {}),
        ...(startDateChanged ? { startDate: values.startDate } : {}),
        ...(endDateChanged ? { endDate: values.endDate } : {}),
        ...(weeklyHoursChanged && weeklyHours !== null ? { weeklyHours } : {}),
        ...(values.explanation.trim() ? { explanation: values.explanation.trim() } : {}),
      }))}
    >
      <h4>Approve request</h4>
      {requestedStartDatePassed && (
        <p className="request-queue-guidance" role="status">
          The requested start date has already passed. Propose a valid future period starting on or after {startDates.afterAcceptanceWindow} (the 72-hour acceptance deadline) and provide an explanation.
        </p>
      )}
      {periodOrHoursChanged ? (
        <p>The date or hours differ from the request. An explanation is required, and no allocation is created until the requester accepts.</p>
      ) : profileChanged ? (
        <p>This approval keeps the requested period and weekly hours but changes the resource profile. An explanation is required.</p>
      ) : !requestedStartDatePassed ? (
        <p>This approval keeps the requested period and weekly hours.</p>
      ) : null}
      <div className="request-approval-comparison">
        <section aria-label="Requested conditions">
          <h5>Requested conditions</h5>
          <dl className="request-queue-details">
            <div><dt>Resource profile</dt><dd>{conditions.resourceProfileName ?? 'Profile unavailable'}</dd></div>
            <div><dt>Period</dt><dd>{conditions.startDate ?? '—'} to {conditions.endDate ?? '—'}</dd></div>
            <div><dt>Weekly hours</dt><dd>{conditions.weeklyHours ?? '—'} hours per week</dd></div>
          </dl>
        </section>
        <section aria-label="Proposed conditions">
          <h5>Proposed conditions</h5>
          <dl className="request-queue-details">
            <div><dt>Resource profile</dt><dd>{selections.profiles.find((profile) => profile.id === selectedProfileId)?.name ?? conditions.resourceProfileName ?? 'Profile unavailable'}</dd></div>
            <div><dt>Period</dt><dd>{selectedStartDate || '—'} to {selectedEndDate || '—'}</dd></div>
            <div><dt>Weekly hours</dt><dd>{weeklyHours ?? (selectedWeeklyHours || '—')} hours per week</dd></div>
          </dl>
        </section>
      </div>
      <label className="form-field">
        <span>Eligible person</span>
        <select {...register('personId', { required: 'Select an eligible person.' })} disabled={disabled || eligiblePeople.length === 0}>
          <option value="">Select a person</option>
          {eligiblePeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
        </select>
        {errors.personId && <span className="field-error">{errors.personId.message}</span>}
        {eligiblePeople.length === 0 && <span className="field-error">No active people are available in this group.</span>}
      </label>
      <label className="form-field">
        <span>Approved resource profile</span>
        <select
          {...register('resourceProfileId', {
            required: 'Select an active resource profile.',
            validate: (value) => eligibleProfiles.some((profile) => profile.id === value) || 'Select a profile in the request group.',
          })}
          disabled={disabled || eligibleProfiles.length === 0}
        >
          {eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name ?? profile.id}</option>)}
        </select>
        {errors.resourceProfileId && <span className="field-error">{errors.resourceProfileId.message}</span>}
      </label>
      <label className="form-field">
        <span>Approved start date</span>
        <input
          type="date"
          min={minimumStartDate}
          {...register('startDate', {
            required: 'Enter a proposed start date.',
            validate: (value) => value >= minimumStartDate || startDateValidationMessage,
          })}
          aria-invalid={errors.startDate ? 'true' : 'false'}
          disabled={disabled}
        />
        {errors.startDate && <span className="field-error">{errors.startDate.message}</span>}
        <span className="field-help">{mustProposeChangedPeriod
          ? 'A proposal that needs acceptance must start on or after its 72-hour response deadline.'
          : 'A final approval cannot start in the past.'}</span>
      </label>
      <label className="form-field">
        <span>Approved end date</span>
        <input
          type="date"
          min={selectedStartDate || minimumStartDate}
          {...register('endDate', {
            required: 'Enter a proposed end date.',
            validate: (value) => {
              if (value < minimumStartDate) {
                return mustProposeChangedPeriod
                  ? 'The proposed end date must be on or after the 72-hour acceptance deadline.'
                  : 'The end date must be today or later.';
              }
              return value >= (selectedStartDate || minimumStartDate) || 'The end date cannot be before the start date.';
            },
          })}
          aria-invalid={errors.endDate ? 'true' : 'false'}
          disabled={disabled}
        />
        {errors.endDate && <span className="field-error">{errors.endDate.message}</span>}
      </label>
      <label className="form-field">
        <span>Approved weekly hours</span>
        <input
          type="text"
          inputMode="decimal"
          {...register('weeklyHours', {
            required: 'Enter proposed weekly hours.',
            validate: (value) => normalizeWeeklyHours(value).value !== null || 'Enter hours above 0 and no more than 40, to one decimal place.',
          })}
          aria-invalid={errors.weeklyHours ? 'true' : 'false'}
          disabled={disabled}
        />
        {errors.weeklyHours && <span className="field-error">{errors.weeklyHours.message}</span>}
      </label>
      <label className="form-field request-queue-reason-field">
        <span>Explanation <span className="optional-label">{explanationRequired ? '(required for changed conditions)' : '(optional)'}</span></span>
        <textarea
          {...register('explanation', {
            maxLength: { value: 2000, message: 'Use no more than 2,000 characters.' },
            validate: (value) => !explanationRequired || Boolean(value.trim()) || (mustProposeChangedPeriod
              ? 'Explain the proposed date or hours changes.'
              : 'Provide an explanation when correcting the resource profile.'),
          })}
          maxLength={2000}
          aria-invalid={errors.explanation ? 'true' : 'false'}
          disabled={disabled}
          aria-required={explanationRequired}
        />
        {errors.explanation && <span className="field-error">{errors.explanation.message}</span>}
      </label>
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={disabled || eligiblePeople.length === 0 || eligibleProfiles.length === 0}>Approve request</button>
      </div>
    </form>
  );
}

export function ReferenceCorrectionForm({
  item,
  selections,
  disabled: actionDisabled,
  onSubmit,
}: {
  item: RequestQueueItem;
  selections: QueueSelections;
  disabled: boolean;
  onSubmit: (correction: ReferenceCorrectionValues) => Promise<void>;
}) {
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm<ReferenceCorrectionValues>({
    defaultValues: { initiativeId: '', groupId: '', resourceProfileId: '', personId: '', reason: '' },
  });
  const disabled = actionDisabled || isSubmitting;
  const selectedGroupId = useWatch({ control, name: 'groupId' });
  const currentGroupId = readValue(item, 'groupId');
  const effectiveGroupId = selectedGroupId || currentGroupId;
  const activeProfiles = selections.profiles.filter((profile) => profile.groupId === effectiveGroupId);
  const eligibleReplacementPeople = selections.people.filter((person) => person.groupId === effectiveGroupId);
  const canReplacePerson = (item.decisionState === 'PRE_N3' || item.decisionState === 'ESCALATION')
    && (item.impediments?.includes('PERSON_INACTIVE') === true || item.impediments?.includes('PERSON_LEFT_GROUP') === true);
  const correctionHelp = item.decisionState === 'REQUIRES_REVALIDATION'
    ? 'This correction counts as presentation. The request stays in revalidation until an authorized decision or referral follows.'
    : item.decisionState === 'PRE_N3' || item.decisionState === 'ESCALATION'
      ? 'This correction is recorded with a reason and keeps the request in its current exception stage.'
      : 'Choose an active replacement when a reference needs correction. The presentation deadline stays unchanged.';

  return (
    <form className="request-queue-action-form" aria-label={`Correct references for request ${item.id}`} onSubmit={handleSubmit((values) => onSubmit({
      ...(values.initiativeId ? { initiativeId: values.initiativeId } : {}),
      ...(values.groupId ? { groupId: values.groupId } : {}),
      ...(values.resourceProfileId ? { resourceProfileId: values.resourceProfileId } : {}),
      ...(values.personId ? { personId: values.personId } : {}),
      reason: values.reason.trim(),
    }))}>
      <h4>Correct request references</h4>
      <p>{correctionHelp}</p>
      <label className="form-field">
        <span>ITDM</span>
        <select {...register('initiativeId')} disabled={disabled}>
          <option value="">Keep current ITDM</option>
          {selections.initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{optionLabel(initiative)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Group</span>
        <select {...register('groupId')} disabled={disabled}>
          <option value="">Keep current group</option>
          {selections.groups.map((group) => <option key={group.id} value={group.id}>{optionLabel(group)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Resource profile</span>
        <select {...register('resourceProfileId', {
          validate: (value) => Boolean(value || !selectedGroupId) || 'Choose a resource profile in the new group.',
        })} disabled={disabled}>
          <option value="">Keep current profile</option>
          {activeProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name ?? profile.id}</option>)}
        </select>
        {errors.resourceProfileId && <span className="field-error">{errors.resourceProfileId.message}</span>}
      </label>
      {canReplacePerson && (
        <label className="form-field">
          <span>Replacement person</span>
          <select {...register('personId')} disabled={disabled || eligibleReplacementPeople.length === 0}>
            <option value="">Keep current person</option>
            {eligibleReplacementPeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
          <span className="field-help">Choose an active person in the current group. Correct the group first if the replacement belongs to another group.</span>
          {eligibleReplacementPeople.length === 0 && <span className="field-error">No active people are available for the current group.</span>}
        </label>
      )}
      <label className="form-field request-queue-reason-field">
        <span>Reason</span>
        <textarea {...register('reason', { required: 'Provide a reason.', maxLength: { value: 2000, message: 'Use no more than 2,000 characters.' }, validate: (value) => Boolean(value.trim()) || 'Provide a reason.' })} maxLength={2000} disabled={disabled} />
        {errors.reason && <span className="field-error">{errors.reason.message}</span>}
      </label>
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={disabled}>Save reference correction</button>
      </div>
    </form>
  );
}

export function AdministrativeRemovalForm({ disabled: actionDisabled, onSubmit }: { disabled: boolean; onSubmit: (reason: string) => Promise<void> }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RemovalValues>({ defaultValues: { reason: '' } });
  const disabled = actionDisabled || isSubmitting;
  return (
    <form className="request-queue-action-form" aria-label="Administrative request removal" onSubmit={handleSubmit((values) => onSubmit(values.reason.trim()))}>
      <h4>Remove request from the active queue</h4>
      <p>The requester will be notified. The request and its submission reference remain available in the audit.</p>
      <label className="form-field request-queue-reason-field">
        <span>Reason</span>
        <textarea {...register('reason', { required: 'Provide a reason.', maxLength: { value: 2000, message: 'Use no more than 2,000 characters.' }, validate: (value) => Boolean(value.trim()) || 'Provide a reason.' })} maxLength={2000} disabled={disabled} />
        {errors.reason && <span className="field-error">{errors.reason.message}</span>}
      </label>
      <div className="form-actions">
        <button type="submit" className="secondary-button" disabled={disabled}>Confirm removal</button>
      </div>
    </form>
  );
}
