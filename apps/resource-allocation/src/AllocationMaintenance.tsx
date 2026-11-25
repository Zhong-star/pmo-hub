import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigationFormProtection } from './NavigationProtection';
import { businessDate, formatCalendarDate, normalizeWeeklyHours } from './timeAndHours';
import {
  ALLOCATIONS_QUERY_ROOT,
  AllocationRequestError,
  allocationCategoryLabel,
  getGroupAllocationOptions,
  isOperationalCategory,
  operationalCategories,
  reopenAllocation,
  updateAllocation,
  type AllocationRecord,
  type ReopenAllocationInput,
  type UpdateAllocationInput,
} from './allocationApi';

interface AllocationMaintenanceProps {
  localUserId: string;
  allocation: AllocationRecord;
  etag: string | undefined;
  mode: 'edit' | 'reopen';
  isAdmin: boolean;
  onSaved: (allocation: AllocationRecord) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onAccessDenied: () => void;
}

interface MaintenanceForm {
  personId: string;
  resourceProfileId: string;
  category: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
  classification: 'INTERNAL' | 'THIRD_PARTY' | 'UNCLASSIFIED';
  confirmDerivedState: boolean;
  reason: string;
}

interface Attempt {
  payloadKey: string;
  idempotencyKey: string;
  correlationId: string;
}

const fieldNames = ['personId', 'resourceProfileId', 'category', 'startDate', 'endDate', 'weeklyHours', 'comment', 'classification', 'reason'] as const;

function defaults(allocation: AllocationRecord): MaintenanceForm {
  return {
    personId: allocation.person.personId,
    resourceProfileId: allocation.resourceProfile?.id ?? '',
    category: allocation.category ?? '',
    startDate: allocation.startDate,
    endDate: allocation.endDate,
    weeklyHours: String(allocation.weeklyHours),
    comment: allocation.comment ?? '',
    classification: allocation.classification ?? 'UNCLASSIFIED',
    confirmDerivedState: false,
    reason: '',
  };
}

/** Mirrors the API: held states survive while the period is open, except for Vacation; a past end means Done. */
export function previewState(current: AllocationRecord['state'], category: string, startDate: string, endDate: string, mode: 'edit' | 'reopen'): string {
  const today = businessDate();
  if (endDate < today) return 'Done';
  if (mode === 'edit' && category !== 'VACATION' && (current === 'SUSPENDED' || current === 'ALLOCATED_WITHOUT_ACTION')) {
    return current === 'SUSPENDED' ? 'Suspended' : 'Allocated without action';
  }
  return startDate > today ? 'Not started' : 'In progress';
}

function versionFrom(etag: string | undefined): number | null {
  const match = etag?.match(/^"([1-9]\d*)"$/);
  return match ? Number(match[1]) : null;
}

export function AllocationMaintenance({ localUserId, allocation, etag, mode, isAdmin, onSaved, onClose, onReload, onAccessDenied }: AllocationMaintenanceProps) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [stale, setStale] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const form = useForm<MaintenanceForm>({ defaultValues: defaults(allocation), mode: 'onSubmit', reValidateMode: 'onChange' });
  const { register, control, handleSubmit, getValues, setError, formState, reset } = form;
  const values = useWatch({ control }) as MaintenanceForm;
  const category = values.category ?? '';
  const vacation = category === 'VACATION';
  const operational = isOperationalCategory(allocation.category);
  const enteringVacation = vacation && allocation.category !== 'VACATION';
  const heldState = allocation.state === 'SUSPENDED' || allocation.state === 'ALLOCATED_WITHOUT_ACTION';

  const optionsQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, 'creation-options', allocation.group.id, 'direct'],
    queryFn: () => getGroupAllocationOptions(localUserId, allocation.group.id, true),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async ({ input, next, version }: { input: UpdateAllocationInput | ReopenAllocationInput; next: Attempt; version: number }) => (
      mode === 'edit'
        ? updateAllocation(localUserId, allocation.id, version, input as UpdateAllocationInput, next.idempotencyKey, next.correlationId)
        : reopenAllocation(localUserId, allocation.id, version, input as ReopenAllocationInput, next.idempotencyKey, next.correlationId)
    ),
    onSuccess: (saved) => {
      setAttempt(null);
      reset(defaults(saved));
      onSaved(saved);
    },
    onError: (error) => {
      if (error instanceof AllocationRequestError && error.status === 401) {
        onAccessDenied();
        return;
      }
      setStale(error instanceof AllocationRequestError && error.status === 412);
      for (const fieldError of error instanceof AllocationRequestError ? error.problem?.errors ?? [] : []) {
        if ((fieldNames as readonly string[]).includes(fieldError.path)) {
          setError(fieldError.path as typeof fieldNames[number], { type: 'server', message: fieldError.message });
        }
      }
    },
  });
  const guardClose = useNavigationFormProtection(mode === 'edit' ? 'allocation change' : 'allocation reopening', formState.isDirty, mutation.isPending);

  useEffect(() => { headingRef.current?.focus(); }, []);

  function buildInput(formValues: MaintenanceForm): UpdateAllocationInput | ReopenAllocationInput {
    const base = defaults(allocation);
    const reason = formValues.reason.trim();
    if (mode === 'reopen') {
      return {
        reason,
        startDate: formValues.startDate,
        endDate: formValues.endDate,
        ...(formValues.personId !== base.personId ? { personId: formValues.personId } : {}),
        ...(formValues.resourceProfileId && formValues.resourceProfileId !== base.resourceProfileId ? { resourceProfileId: formValues.resourceProfileId } : {}),
      };
    }
    const nextVacation = formValues.category === 'VACATION';
    const input: UpdateAllocationInput = { reason };
    if (formValues.personId !== base.personId) input.personId = formValues.personId;
    if (formValues.category !== base.category) input.category = formValues.category as UpdateAllocationInput['category'];
    if (!nextVacation && formValues.resourceProfileId !== base.resourceProfileId) input.resourceProfileId = formValues.resourceProfileId;
    if (formValues.startDate !== base.startDate) input.startDate = formValues.startDate;
    if (formValues.endDate !== base.endDate) input.endDate = formValues.endDate;
    const hours = normalizeWeeklyHours(formValues.weeklyHours).value;
    if (!nextVacation && hours !== null && (hours !== allocation.weeklyHours || allocation.category === 'VACATION')) input.weeklyHours = hours;
    if (!nextVacation && (formValues.comment.trim() !== base.comment.trim() || allocation.category === 'VACATION')) input.comment = formValues.comment.trim() || null;
    if (isAdmin && formValues.classification !== base.classification) input.classification = formValues.classification === 'UNCLASSIFIED' ? null : formValues.classification;
    if (nextVacation && allocation.category !== 'VACATION' && heldState) input.confirmDerivedState = formValues.confirmDerivedState;
    return input;
  }

  async function submit(formValues: MaintenanceForm) {
    const version = versionFrom(etag);
    if (version === null || version !== allocation.version) {
      setStale(true);
      return;
    }
    const input = buildInput(formValues);
    const payloadKey = JSON.stringify({ version, input });
    const next = attempt?.payloadKey === payloadKey
      ? attempt
      : { payloadKey, idempotencyKey: window.crypto.randomUUID(), correlationId: window.crypto.randomUUID() };
    setAttempt(next);
    try {
      await mutation.mutateAsync({ input, next, version });
    } catch {
      // The mutation exposes the problem and keeps the entered values.
    }
  }

  async function reload() {
    await onReload();
    setStale(false);
    setAttempt(null);
    mutation.reset();
  }

  const people = optionsQuery.data?.people ?? [];
  const profiles = optionsQuery.data?.profiles ?? [];
  const preview = previewState(allocation.state, category, values.startDate ?? '', values.endDate ?? '', mode);
  const title = mode === 'edit' ? 'Change allocation' : 'Reopen allocation';
  const errorMessage = mutation.error instanceof AllocationRequestError
    ? mutation.error.status === null
      ? 'The change could not be confirmed. Retry to resend the same change safely.'
      : mutation.error.message
    : mutation.error ? 'The allocation could not be saved.' : '';

  return (
    <form className="allocation-action-form allocation-maintenance-form" noValidate onSubmit={handleSubmit(submit)} aria-labelledby="allocation-maintenance-title">
      <h4 id="allocation-maintenance-title" ref={headingRef} tabIndex={-1}>{title}</h4>
      <p>
        {mode === 'edit'
          ? 'The request keeps its original decision; this changes the current commitment and is recorded in its history. The group and ITDM cannot change.'
          : 'Reopening sets new dates and is recorded in the history. The group and ITDM stay the same and must be active.'}
      </p>
      <div className="allocation-create-grid">
        <label>
          <span>Person</span>
          <select {...register('personId', { required: 'Choose a person.' })} aria-invalid={Boolean(formState.errors.personId)}>
            {!people.some((person) => person.id === allocation.person.personId) && (
              <option value={allocation.person.personId}>{allocation.person.displayName}</option>
            )}
            {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
          {formState.errors.personId && <span className="field-error" role="alert">{formState.errors.personId.message}</span>}
        </label>
        {mode === 'edit' && operational && (
          <label>
            <span>Category</span>
            <select {...register('category')}>
              {operationalCategories.map((value) => <option key={value} value={value}>{allocationCategoryLabel(value)}</option>)}
            </select>
          </label>
        )}
        {!vacation && (
          <label>
            <span>Resource profile</span>
            <select
              {...register('resourceProfileId', { validate: (value) => getValues('category') === 'VACATION' || value !== '' || 'Choose an active resource profile.' })}
              aria-invalid={Boolean(formState.errors.resourceProfileId)}
            >
              <option value="">Choose a profile</option>
              {allocation.resourceProfile && !profiles.some((profile) => profile.id === allocation.resourceProfile?.id) && (
                <option value={allocation.resourceProfile.id}>{allocation.resourceProfile.name}{allocation.resourceProfile.active ? '' : ' (inactive)'}</option>
              )}
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            {formState.errors.resourceProfileId && <span className="field-error" role="alert">{formState.errors.resourceProfileId.message}</span>}
          </label>
        )}
        <label>
          <span>{mode === 'reopen' ? 'New start date' : 'Start date'}</span>
          <input type="date" {...register('startDate', { required: 'Enter a start date.' })} aria-invalid={Boolean(formState.errors.startDate)} />
          {formState.errors.startDate && <span className="field-error" role="alert">{formState.errors.startDate.message}</span>}
        </label>
        <label>
          <span>{mode === 'reopen' ? 'New end date (inclusive)' : 'End date (inclusive)'}</span>
          <input
            type="date"
            {...register('endDate', {
              required: 'Enter an end date.',
              validate: (value) => value >= getValues('startDate') || 'The end date must be on or after the start date.',
            })}
            aria-invalid={Boolean(formState.errors.endDate)}
          />
          {formState.errors.endDate && <span className="field-error" role="alert">{formState.errors.endDate.message}</span>}
        </label>
        {mode === 'edit' && (vacation ? (
          <div className="allocation-create-fixed">
            <span>Weekly hours</span>
            <strong>40 hours/week</strong>
            <small className="field-help">Vacation uses 40 weekly hours, no profile, and no description.</small>
          </div>
        ) : (
          <label>
            <span>Weekly hours</span>
            <input
              inputMode="decimal"
              {...register('weeklyHours', { validate: (value) => getValues('category') === 'VACATION' || normalizeWeeklyHours(value).value !== null || 'Enter hours above 0 and no more than 40.' })}
              aria-invalid={Boolean(formState.errors.weeklyHours)}
            />
            {formState.errors.weeklyHours && <span className="field-error" role="alert">{formState.errors.weeklyHours.message}</span>}
          </label>
        ))}
        {mode === 'edit' && isAdmin && (
          <label>
            <span>Recorded classification</span>
            <select {...register('classification')}>
              <option value="INTERNAL">Internal</option>
              <option value="THIRD_PARTY">Third party</option>
              <option value="UNCLASSIFIED">Unclassified</option>
            </select>
            <small className="field-help">Admin correction only. A person change copies that person&apos;s classification.</small>
          </label>
        )}
        {mode === 'edit' && !vacation && (
          <label className="allocation-create-comment">
            <span>{isOperationalCategory(category) ? 'Activity description' : 'Comment (optional)'}</span>
            <textarea
              {...register('comment', {
                validate: (value) => !isOperationalCategory(getValues('category')) || getValues('category') === 'VACATION' || value.trim() !== '' || 'Describe the operational activity.',
              })}
              aria-invalid={Boolean(formState.errors.comment)}
            />
            {formState.errors.comment && <span className="field-error" role="alert">{formState.errors.comment.message}</span>}
          </label>
        )}
        <label className="allocation-create-comment">
          <span>Reason for this change</span>
          <textarea
            {...register('reason', {
              validate: (value) => value.trim() !== '' || 'Enter a reason for this change.',
              maxLength: { value: 2000, message: 'Use 2,000 characters or fewer.' },
            })}
            aria-invalid={Boolean(formState.errors.reason)}
          />
          {formState.errors.reason && <span className="field-error" role="alert">{formState.errors.reason.message}</span>}
        </label>
      </div>
      <p className="allocation-state-preview" role="status">
        Resulting state: <strong>{preview}</strong> · {values.startDate && values.endDate ? `${formatCalendarDate(values.startDate)} – ${formatCalendarDate(values.endDate)}, last day included` : 'Enter both dates'}
      </p>
      {mode === 'edit' && enteringVacation && heldState && (
        <label className="allocation-confirm-derived">
          <input type="checkbox" {...register('confirmDerivedState', { validate: (value) => !(getValues('category') === 'VACATION' && allocation.category !== 'VACATION' && heldState) || value || 'Confirm the state derived from the dates.' })} />
          <span>Vacation cannot stay {allocation.state === 'SUSPENDED' ? 'suspended' : 'reserved'}. I confirm it becomes {preview.toLowerCase()} from its dates.</span>
        </label>
      )}
      {formState.errors.confirmDerivedState && <span className="field-error" role="alert">{formState.errors.confirmDerivedState.message}</span>}
      {stale && (
        <div className="allocation-stale" role="alert">
          <p>This allocation changed after you opened it. Your entries are kept. Reload the allocation and review it before saving again.</p>
          <button type="button" className="text-button" onClick={() => void reload()}>Reload allocation</button>
        </div>
      )}
      {!stale && errorMessage && <div className="form-error" role="alert"><p>{errorMessage} Your entries are kept.</p></div>}
      <div className="allocation-form-actions">
        <button type="submit" className="primary-button" disabled={mutation.isPending || stale}>
          {mutation.isPending ? 'Saving…' : mode === 'edit' ? 'Save change' : 'Reopen allocation'}
        </button>
        <button type="button" className="secondary-button" onClick={() => guardClose(onClose)} disabled={mutation.isPending}>Close</button>
      </div>
    </form>
  );
}
