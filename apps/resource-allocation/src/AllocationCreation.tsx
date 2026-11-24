import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigationFormProtection } from './NavigationProtection';
import { getManageableProfileGroups } from './resource-profile-administration-api';
import { businessDate, formatCalendarDate, normalizeWeeklyHours } from './timeAndHours';
import {
  ALLOCATIONS_QUERY_ROOT,
  AllocationRequestError,
  allocationCategoryLabel,
  createAllocation,
  getGroupAllocationOptions,
  getInitiativeOptions,
  initiativeCategories,
  isOperationalCategory,
  operationalCategories,
  type AllocationCategory,
  type AllocationRecord,
  type CreateAllocationInput,
} from './allocationApi';

export type AllocationCreatorRole = 'ALLOCATION_USER' | 'ALLOCATION_MODERATOR' | 'ALLOCATION_SUPERVISOR' | 'ALLOCATION_MANAGER' | 'ALLOCATION_ADMIN';

interface AllocationCreationProps {
  localUserId: string;
  personId: string;
  role: AllocationCreatorRole;
  groupId: string | null;
  onAccessDenied: () => void;
  onCreated: (allocation: AllocationRecord) => void;
  onClose: () => void;
}

type Target = 'self' | 'direct';

interface CreationForm {
  target: Target;
  groupId: string;
  personId: string;
  category: AllocationCategory | '';
  resourceProfileId: string;
  initiativeId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
}

interface CreationAttempt {
  payloadKey: string;
  idempotencyKey: string;
  correlationId: string;
}

const fieldNames = ['personId', 'category', 'resourceProfileId', 'initiativeId', 'startDate', 'endDate', 'weeklyHours', 'comment'] as const;
type FieldName = typeof fieldNames[number];

function isFieldName(value: string): value is FieldName {
  return (fieldNames as readonly string[]).includes(value);
}

function emptyForm(): CreationForm {
  const today = businessDate();
  return {
    target: 'self',
    groupId: '',
    personId: '',
    category: '',
    resourceProfileId: '',
    initiativeId: '',
    startDate: today,
    endDate: today,
    weeklyHours: '',
    comment: '',
  };
}

function initialStateLabel(startDate: string, endDate: string): string {
  const today = businessDate();
  if (startDate > today) return 'Not started';
  if (endDate < today) return 'Done';
  return 'In progress';
}

function toInput(values: CreationForm): CreateAllocationInput | null {
  if (!values.category) return null;
  const vacation = values.category === 'VACATION';
  const operational = isOperationalCategory(values.category);
  const hours = vacation ? 40 : normalizeWeeklyHours(values.weeklyHours).value;
  if (hours === null) return null;
  return {
    ...(values.target === 'direct' ? { personId: values.personId } : {}),
    category: values.category,
    ...(vacation ? {} : { resourceProfileId: values.resourceProfileId }),
    ...(operational ? {} : { initiativeId: values.initiativeId }),
    startDate: values.startDate,
    endDate: values.endDate,
    ...(vacation ? {} : { weeklyHours: hours }),
    ...(values.comment.trim() ? { comment: values.comment.trim() } : {}),
  };
}

export function AllocationCreation({ localUserId, personId, role, groupId, onAccessDenied, onCreated, onClose }: AllocationCreationProps) {
  const leader = role !== 'ALLOCATION_USER';
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [attempt, setAttempt] = useState<CreationAttempt | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const form = useForm<CreationForm>({ defaultValues: emptyForm(), mode: 'onSubmit', reValidateMode: 'onChange' });
  const { register, control, handleSubmit, setValue, setError, getValues, formState } = form;
  const values = useWatch({ control }) as CreationForm;
  const target = values.target ?? 'self';
  const category = values.category ?? '';
  const vacation = category === 'VACATION';
  const operational = category !== '' && isOperationalCategory(category);
  const optionsGroupId = target === 'self' ? groupId : (values.groupId || null);

  const leadershipGroupsQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, 'creation-groups'],
    queryFn: async () => {
      const groups: Array<{ id: string; name: string }> = [];
      let cursor: string | null = null;
      do {
        const page = await getManageableProfileGroups(localUserId, cursor);
        groups.push(...page.items);
        cursor = page.page.nextCursor;
      } while (cursor !== null);
      return groups;
    },
    enabled: leader,
    retry: false,
  });
  const groupOptionsQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, 'creation-options', optionsGroupId],
    queryFn: () => getGroupAllocationOptions(localUserId, optionsGroupId!),
    enabled: optionsGroupId !== null,
    retry: false,
  });
  const initiativesQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, 'creation-initiatives'],
    queryFn: () => getInitiativeOptions(localUserId),
    enabled: target === 'direct' && category !== '' && !operational,
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: ({ input, nextAttempt }: { input: CreateAllocationInput; nextAttempt: CreationAttempt }) => (
      createAllocation(localUserId, input, nextAttempt.idempotencyKey, nextAttempt.correlationId)
    ),
    onSuccess: ({ allocation }) => {
      setAttempt(null);
      form.reset(emptyForm());
      onCreated(allocation);
    },
    onError: (error) => {
      if (error instanceof AllocationRequestError && error.status === 401) {
        onAccessDenied();
        return;
      }
      const fieldErrors = error instanceof AllocationRequestError ? error.problem?.errors ?? [] : [];
      const mapped = fieldErrors.filter((fieldError) => isFieldName(fieldError.path));
      if (mapped.length > 0) {
        setStep('edit');
        for (const fieldError of mapped) setError(fieldError.path as FieldName, { type: 'server', message: fieldError.message });
      }
    },
  });
  const guardClose = useNavigationFormProtection('allocation creation', formState.isDirty, createMutation.isPending);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => { if (step === 'review') reviewHeadingRef.current?.focus(); }, [step]);

  const groupFieldRegistration = register('groupId', {
    validate: (value) => getValues('target') === 'self' || value !== '' || 'Choose a group in your scope.',
    onChange: () => {
      setValue('personId', '');
      setValue('resourceProfileId', '');
    },
  });
  const targetRegistration = register('target', {
    onChange: (event: { target: { value: Target } }) => {
      setValue('groupId', '');
      setValue('personId', '');
      setValue('resourceProfileId', '');
      setValue('initiativeId', '');
      if (event.target.value === 'self' && getValues('category') && !isOperationalCategory(getValues('category'))) setValue('category', '');
    },
  });

  const categoryRegistration = register('category', { required: 'Choose a category.' });
  const people = useMemo(
    () => (groupOptionsQuery.data?.people ?? []).filter((person) => person.id !== personId),
    [groupOptionsQuery.data, personId],
  );
  const profiles = groupOptionsQuery.data?.profiles ?? [];
  const categories = target === 'direct' ? [...operationalCategories, ...initiativeCategories] : operationalCategories;
  const selectedPerson = target === 'self' ? null : people.find((person) => person.id === values.personId) ?? null;
  const selectedProfile = profiles.find((profile) => profile.id === values.resourceProfileId) ?? null;
  const selectedInitiative = initiativesQuery.data?.find((initiative) => initiative.id === values.initiativeId) ?? null;
  const selectedGroup = leadershipGroupsQuery.data?.find((group) => group.id === values.groupId) ?? null;
  const hoursPreview = vacation ? 40 : normalizeWeeklyHours(values.weeklyHours ?? '').value;

  function payloadKey(input: CreateAllocationInput): string {
    return JSON.stringify(input);
  }

  async function confirm() {
    const input = toInput(getValues());
    if (!input) {
      setStep('edit');
      return;
    }
    const key = payloadKey(input);
    const nextAttempt = attempt && attempt.payloadKey === key
      ? attempt
      : { payloadKey: key, idempotencyKey: window.crypto.randomUUID(), correlationId: window.crypto.randomUUID() };
    setAttempt(nextAttempt);
    try {
      await createMutation.mutateAsync({ input, nextAttempt });
    } catch {
      // The mutation exposes the error and keeps the entered values for review or retry.
    }
  }

  const errorMessage = createMutation.error instanceof AllocationRequestError
    ? createMutation.error.status === null
      ? 'The allocation could not be confirmed. Retry to resend the same allocation without creating a duplicate.'
      : createMutation.error.message
    : createMutation.error ? 'The allocation could not be recorded.' : '';

  return (
    <section className="allocation-create" aria-labelledby="allocation-create-heading">
      <div className="allocation-detail-heading">
        <div>
          <p className="eyebrow">New commitment</p>
          <h3 id="allocation-create-heading">Record an allocation</h3>
          <p>It is approved when recorded. Overlaps and totals above 40 hours are allowed.</p>
        </div>
        <button type="button" className="text-button" onClick={() => guardClose(onClose)}>Close</button>
      </div>

      {step === 'edit' && (
        <form className="allocation-create-form" noValidate onSubmit={handleSubmit(() => { createMutation.reset(); setStep('review'); })}>
          {leader && (
            <fieldset className="allocation-create-target">
              <legend>Allocate</legend>
              <label><input type="radio" value="self" {...targetRegistration} /> Myself</label>
              <label><input type="radio" value="direct" {...targetRegistration} /> A person in my scope</label>
            </fieldset>
          )}
          {target === 'self' && !groupId && (
            <p className="form-error" role="alert">Your profile is not linked to a group, so you cannot record your own allocations. Ask an Admin to add you to a group.</p>
          )}
          <div className="allocation-create-grid">
            {target === 'direct' && (
              <>
                <label>
                  <span>Group</span>
                  <select {...groupFieldRegistration} aria-invalid={Boolean(formState.errors.groupId)} aria-describedby={formState.errors.groupId ? 'create-group-error' : undefined}>
                    <option value="">Choose a group</option>
                    {(leadershipGroupsQuery.data ?? []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  {leadershipGroupsQuery.isError && <span className="field-error" role="alert">Groups in your scope could not be loaded.</span>}
                  {formState.errors.groupId && <span id="create-group-error" className="field-error" role="alert">{formState.errors.groupId.message}</span>}
                </label>
                <label>
                  <span>Person</span>
                  <select
                    {...register('personId', { validate: (value) => getValues('target') === 'self' || value !== '' || 'Choose an active person in this group.' })}
                    disabled={!values.groupId}
                    aria-invalid={Boolean(formState.errors.personId)}
                    aria-describedby={formState.errors.personId ? 'create-person-error' : undefined}
                  >
                    <option value="">{values.groupId ? 'Choose a person' : 'Choose a group first'}</option>
                    {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
                  </select>
                  {formState.errors.personId && <span id="create-person-error" className="field-error" role="alert">{formState.errors.personId.message}</span>}
                </label>
              </>
            )}
            <label>
              <span>Category</span>
              <select
                {...categoryRegistration}
                ref={(element) => { categoryRegistration.ref(element); firstFieldRef.current = element; }}
                aria-invalid={Boolean(formState.errors.category)}
                aria-describedby={formState.errors.category ? 'create-category-error' : 'create-category-help'}
              >
                <option value="">Choose a category</option>
                <optgroup label="Operational">
                  {operationalCategories.map((value) => <option key={value} value={value}>{allocationCategoryLabel(value)}</option>)}
                </optgroup>
                {target === 'direct' && (
                  <optgroup label="Initiative (ITDM required)">
                    {initiativeCategories.map((value) => <option key={value} value={value}>{allocationCategoryLabel(value)}</option>)}
                  </optgroup>
                )}
              </select>
              <small id="create-category-help" className="field-help">
                {categories.length === operationalCategories.length ? 'Own allocations use operational categories only.' : 'Initiative categories require an ITDM.'}
              </small>
              {formState.errors.category && <span id="create-category-error" className="field-error" role="alert">{formState.errors.category.message}</span>}
            </label>
            {category !== '' && !operational && (
              <label>
                <span>ITDM initiative</span>
                <select
                  {...register('initiativeId', { validate: (value) => isOperationalCategory(getValues('category')) || value !== '' || 'Choose an active ITDM.' })}
                  aria-invalid={Boolean(formState.errors.initiativeId)}
                  aria-describedby={formState.errors.initiativeId ? 'create-initiative-error' : undefined}
                >
                  <option value="">{initiativesQuery.isPending ? 'Loading ITDMs…' : 'Choose an ITDM'}</option>
                  {(initiativesQuery.data ?? []).map((initiative) => <option key={initiative.id} value={initiative.id}>{initiative.code} · {initiative.name}</option>)}
                </select>
                {formState.errors.initiativeId && <span id="create-initiative-error" className="field-error" role="alert">{formState.errors.initiativeId.message}</span>}
              </label>
            )}
            {category !== '' && !vacation && (
              <label>
                <span>Resource profile</span>
                <select
                  {...register('resourceProfileId', { validate: (value) => getValues('category') === 'VACATION' || value !== '' || 'Choose an active resource profile.' })}
                  disabled={optionsGroupId === null}
                  aria-invalid={Boolean(formState.errors.resourceProfileId)}
                  aria-describedby={formState.errors.resourceProfileId ? 'create-profile-error' : undefined}
                >
                  <option value="">{groupOptionsQuery.isPending && optionsGroupId ? 'Loading profiles…' : 'Choose a profile'}</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                {groupOptionsQuery.isSuccess && profiles.length === 0 && <span className="field-help">This group has no active resource profiles.</span>}
                {formState.errors.resourceProfileId && <span id="create-profile-error" className="field-error" role="alert">{formState.errors.resourceProfileId.message}</span>}
              </label>
            )}
            <label>
              <span>Start date</span>
              <input
                type="date"
                {...register('startDate', { required: 'Enter a start date.' })}
                aria-invalid={Boolean(formState.errors.startDate)}
                aria-describedby={formState.errors.startDate ? 'create-start-error' : undefined}
              />
              {formState.errors.startDate && <span id="create-start-error" className="field-error" role="alert">{formState.errors.startDate.message}</span>}
            </label>
            <label>
              <span>End date (inclusive)</span>
              <input
                type="date"
                {...register('endDate', {
                  required: 'Enter an end date.',
                  validate: (value) => !getValues('startDate') || value >= getValues('startDate') || 'The end date must be on or after the start date.',
                })}
                aria-invalid={Boolean(formState.errors.endDate)}
                aria-describedby={formState.errors.endDate ? 'create-end-error' : undefined}
              />
              {formState.errors.endDate && <span id="create-end-error" className="field-error" role="alert">{formState.errors.endDate.message}</span>}
            </label>
            {vacation ? (
              <div className="allocation-create-fixed">
                <span>Weekly hours</span>
                <strong>40 hours/week</strong>
                <small className="field-help">Vacation always uses 40 weekly hours and no resource profile.</small>
              </div>
            ) : (
              <label>
                <span>Weekly hours</span>
                <input
                  inputMode="decimal"
                  {...register('weeklyHours', {
                    validate: (value) => getValues('category') === 'VACATION' || normalizeWeeklyHours(value).value !== null || 'Enter hours above 0 and no more than 40, to one decimal place.',
                  })}
                  aria-invalid={Boolean(formState.errors.weeklyHours)}
                  aria-describedby={formState.errors.weeklyHours ? 'create-hours-error' : 'create-hours-help'}
                />
                <small id="create-hours-help" className="field-help">Up to 40 per allocation, rounded to one decimal place.</small>
                {formState.errors.weeklyHours && <span id="create-hours-error" className="field-error" role="alert">{formState.errors.weeklyHours.message}</span>}
              </label>
            )}
            {!vacation && (
              <label className="allocation-create-comment">
                <span>{category === '' ? 'Comment' : operational ? 'Activity description' : 'Comment (optional)'}</span>
                <textarea
                  {...register('comment', {
                    validate: (value) => {
                      const current = getValues('category');
                      if (current && isOperationalCategory(current) && current !== 'VACATION' && !value.trim()) return 'Describe the operational activity.';
                      return value.length <= 2000 || 'Use 2,000 characters or fewer.';
                    },
                  })}
                  aria-invalid={Boolean(formState.errors.comment)}
                  aria-describedby={formState.errors.comment ? 'create-comment-error' : undefined}
                />
                {formState.errors.comment && <span id="create-comment-error" className="field-error" role="alert">{formState.errors.comment.message}</span>}
              </label>
            )}
          </div>
          {errorMessage && step === 'edit' && <div className="form-error" role="alert"><p>{errorMessage}</p></div>}
          <div className="allocation-form-actions">
            <button type="submit" className="primary-button" disabled={target === 'self' && !groupId}>Review allocation</button>
            <button type="button" className="secondary-button" onClick={() => guardClose(onClose)}>Cancel</button>
          </div>
        </form>
      )}

      {step === 'review' && (
        <div className="allocation-create-review">
          <h4 ref={reviewHeadingRef} tabIndex={-1}>Review before recording</h4>
          <dl className="allocation-metadata">
            <div><dt>Person</dt><dd>{selectedPerson ? selectedPerson.displayName : 'You'}</dd></div>
            {selectedGroup && <div><dt>Group</dt><dd>{selectedGroup.name}</dd></div>}
            <div><dt>Category</dt><dd>{allocationCategoryLabel(category)}</dd></div>
            {selectedInitiative && <div><dt>ITDM</dt><dd>{selectedInitiative.code} · {selectedInitiative.name}</dd></div>}
            <div><dt>Resource profile</dt><dd>{vacation ? 'Not used for Vacation' : selectedProfile?.name ?? '—'}</dd></div>
            <div><dt>Period</dt><dd>{formatCalendarDate(values.startDate)} – {formatCalendarDate(values.endDate)}</dd></div>
            <div><dt>Weekly hours</dt><dd>{hoursPreview === null ? '—' : `${hoursPreview.toFixed(1)} hours/week`}</dd></div>
            <div><dt>Starts as</dt><dd>{initialStateLabel(values.startDate, values.endDate)}</dd></div>
            {values.comment?.trim() && !vacation && <div className="allocation-metadata-wide"><dt>Description</dt><dd>{values.comment.trim()}</dd></div>}
          </dl>
          <p className="field-help">
            {target === 'self'
              ? 'Your group leadership will be notified.'
              : `${selectedPerson?.displayName ?? 'The person'} will be notified.`}
          </p>
          {errorMessage && (
            <div className="form-error" role="alert">
              <p>{errorMessage} Your entries are kept.</p>
            </div>
          )}
          <div className="allocation-form-actions">
            <button type="button" className="primary-button" onClick={() => void confirm()} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Recording…' : attempt && createMutation.isError ? 'Retry recording' : 'Record allocation'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setStep('edit')} disabled={createMutation.isPending}>Edit details</button>
          </div>
        </div>
      )}
    </section>
  );
}
