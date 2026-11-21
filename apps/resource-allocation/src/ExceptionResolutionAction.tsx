import { useForm, useWatch } from 'react-hook-form';
import type { ApprovedRequestConditions } from './requestApi';
import type { ExceptionResolutionStrategy, ExceptionResolutionInput, ExceptionStrategyInput, QueueSelections, RequestQueueItem } from './requestQueueApi';
import { businessDate, normalizeWeeklyHours } from './timeAndHours';

interface ExceptionResolutionActionProps {
  item: RequestQueueItem;
  selections: QueueSelections;
  canRecord: boolean;
  canResolve: boolean;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onRecord: (input: ExceptionStrategyInput) => Promise<void>;
  onResolve: (input: ExceptionResolutionInput) => Promise<void>;
}

interface ResolutionValues {
  strategy: ExceptionResolutionStrategy;
  reason: string;
  affectedInitiativeIds: string[];
  resolutionAction: 'record' | 'resolve';
  personId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
}

const strategyOptions: Array<{ value: ExceptionResolutionStrategy; label: string }> = [
  { value: 'OUTSOURCE', label: 'Outsource' },
  { value: 'WAIT_FOR_EMB_RESOURCE', label: 'Wait for EMB Resource' },
  { value: 'DEPRIORITIZE_OTHER_DEMANDS', label: 'Deprioritize other demands' },
];

function approvedValue<T extends keyof ApprovedRequestConditions>(item: RequestQueueItem, key: T): ApprovedRequestConditions[T] | undefined {
  return item.approvedConditions?.[key];
}

function initiativeLabel(initiative: QueueSelections['initiatives'][number]): string {
  return initiative.code ? `${initiative.code} — ${initiative.name ?? ''}` : initiative.name ?? initiative.id;
}

export function ExceptionResolutionAction({
  item,
  selections,
  canRecord,
  canResolve,
  disabled,
  open,
  onToggle,
  onRecord,
  onResolve,
}: ExceptionResolutionActionProps) {
  const today = businessDate();
  const initialAction = canResolve && !canRecord ? 'resolve' : 'record';
  const form = useForm<ResolutionValues>({
    defaultValues: {
      strategy: item.resolutionStrategy ?? 'OUTSOURCE',
      reason: item.resolutionReason ?? '',
      affectedInitiativeIds: item.affectedInitiativeIds ?? [],
      resolutionAction: initialAction,
      personId: approvedValue(item, 'personId') ?? '',
      resourceProfileId: approvedValue(item, 'resourceProfileId') ?? item.requestedConditions.resourceProfileId,
      startDate: approvedValue(item, 'startDate') ?? item.requestedConditions.startDate ?? today,
      endDate: approvedValue(item, 'endDate') ?? item.requestedConditions.endDate ?? today,
      weeklyHours: String(approvedValue(item, 'weeklyHours') ?? item.requestedConditions.weeklyHours ?? ''),
    },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const strategy = useWatch({ control: form.control, name: 'strategy' });
  const resolutionAction = useWatch({ control: form.control, name: 'resolutionAction' });
  const selectedStartDate = useWatch({ control: form.control, name: 'startDate' });
  const eligiblePeople = selections.people.filter((person) => person.groupId === item.requestedConditions.groupId);
  const eligibleProfiles = selections.profiles.filter((profile) => profile.groupId === item.requestedConditions.groupId);

  async function submit(values: ResolutionValues) {
    const common: ExceptionStrategyInput = {
      strategy: values.strategy,
      reason: values.reason.trim(),
      ...(values.strategy === 'DEPRIORITIZE_OTHER_DEMANDS' ? { affectedInitiativeIds: values.affectedInitiativeIds } : {}),
    };
    if (values.resolutionAction === 'record') {
      await onRecord(common);
      return;
    }
    const weeklyHours = normalizeWeeklyHours(values.weeklyHours).value;
    if (weeklyHours === null) {
      form.setError('weeklyHours', { type: 'validate', message: 'Enter hours above 0 and no more than 40, to one decimal place.' });
      return;
    }
    const resolution: ExceptionResolutionInput = {
      ...common,
      personId: values.personId,
      resourceProfileId: values.resourceProfileId,
      startDate: values.startDate,
      endDate: values.endDate,
      weeklyHours,
    };
    await onResolve(resolution);
  }

  return (
    <div className="request-exception-resolution">
      {!open && (
        <button type="button" className="secondary-button" aria-expanded="false" onClick={onToggle} disabled={disabled}>
          {canRecord ? 'Record strategy' : 'Resolve exception'}
        </button>
      )}
      {open && (
        <form
          className="request-queue-action-form"
          aria-label={`Resolve exception ${item.id}`}
          noValidate
          onSubmit={form.handleSubmit(submit)}
        >
          <h4>Choose how to resolve this exception</h4>
          <p>{resolutionAction === 'resolve'
            ? 'This is a final Admin approval. It creates the allocation now without asking the requester to accept.'
            : 'Recording a strategy adds it to the history and keeps the request in its current resolution stage. No allocation is created.'}</p>

          <label className="form-field">
            <span>Resolution strategy</span>
            <select {...form.register('strategy', { required: 'Choose a resolution strategy.' })} disabled={disabled}>
              {strategyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {form.formState.errors.strategy && <span className="field-error">{form.formState.errors.strategy.message}</span>}
          </label>

          <label className="form-field request-queue-reason-field">
            <span>Reason</span>
            <textarea
              maxLength={2000}
              aria-invalid={Boolean(form.formState.errors.reason)}
              {...form.register('reason', {
                required: 'Provide a reason.',
                validate: (value) => Boolean(value.trim()) || 'Provide a reason.',
              })}
              disabled={disabled}
            />
            <span className="field-help">Required · up to 2,000 characters.</span>
            {form.formState.errors.reason && <span className="field-error">{form.formState.errors.reason.message}</span>}
          </label>

          {strategy === 'DEPRIORITIZE_OTHER_DEMANDS' && (
            <fieldset className="request-affected-initiatives">
              <legend>Affected ITDMs</legend>
              <p>Select the other ITDMs affected by this strategy. Their existing allocations will not be changed.</p>
              {selections.initiatives.length === 0 && <span className="field-error">No active ITDMs are available.</span>}
              {selections.initiatives.map((initiative) => (
                <label key={initiative.id} className="request-affected-initiative-option">
                  <input
                    type="checkbox"
                    value={initiative.id}
                    {...form.register('affectedInitiativeIds', {
                      validate: (ids) => strategy !== 'DEPRIORITIZE_OTHER_DEMANDS' || ids.length > 0 || 'Select at least one affected ITDM.',
                    })}
                    disabled={disabled}
                  />
                  <span>{initiativeLabel(initiative)}</span>
                </label>
              ))}
              {form.formState.errors.affectedInitiativeIds?.message && <span className="field-error">{form.formState.errors.affectedInitiativeIds.message}</span>}
            </fieldset>
          )}

          {canRecord && canResolve && (
            <label className="form-field request-queue-reason-field">
              <span>Resolution action</span>
              <select {...form.register('resolutionAction')} disabled={disabled}>
                <option value="record">Record strategy and keep request in this stage</option>
                <option value="resolve">Resolve and approve now</option>
              </select>
            </label>
          )}

          {resolutionAction === 'resolve' && (
            <>
              <label className="form-field">
                <span>Eligible person</span>
                <select
                  {...form.register('personId', {
                    required: 'Select an eligible person.',
                    validate: (value) => eligiblePeople.some((person) => person.id === value) || 'Select an active person in the request group.',
                  })}
                  disabled={disabled || eligiblePeople.length === 0}
                >
                  <option value="">Select a person</option>
                  {eligiblePeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
                </select>
                {form.formState.errors.personId && <span className="field-error">{form.formState.errors.personId.message}</span>}
                {eligiblePeople.length === 0 && <span className="field-error">No active people are available in this group.</span>}
              </label>
              <label className="form-field">
                <span>Final resource profile</span>
                <select
                  {...form.register('resourceProfileId', {
                    required: 'Select an active resource profile.',
                    validate: (value) => eligibleProfiles.some((profile) => profile.id === value) || 'Select a profile in the request group.',
                  })}
                  disabled={disabled || eligibleProfiles.length === 0}
                >
                  <option value="">Select a resource profile</option>
                  {eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name ?? profile.id}</option>)}
                </select>
                {form.formState.errors.resourceProfileId && <span className="field-error">{form.formState.errors.resourceProfileId.message}</span>}
                {eligibleProfiles.length === 0 && <span className="field-error">No active resource profiles are available in this group.</span>}
              </label>
              <label className="form-field">
                <span>Final start date</span>
                <input
                  type="date"
                  min={today}
                  {...form.register('startDate', {
                    required: 'Enter a final start date.',
                    validate: (value) => value >= today || 'The final start date must be today or later.',
                  })}
                  aria-invalid={Boolean(form.formState.errors.startDate)}
                  disabled={disabled}
                />
                {form.formState.errors.startDate && <span className="field-error">{form.formState.errors.startDate.message}</span>}
              </label>
              <label className="form-field">
                <span>Final end date</span>
                <input
                  type="date"
                  min={selectedStartDate || today}
                  {...form.register('endDate', {
                    required: 'Enter a final end date.',
                    validate: (value) => value >= (selectedStartDate || today) || 'The final end date cannot be before the start date.',
                  })}
                  aria-invalid={Boolean(form.formState.errors.endDate)}
                  disabled={disabled}
                />
                {form.formState.errors.endDate && <span className="field-error">{form.formState.errors.endDate.message}</span>}
              </label>
              <label className="form-field">
                <span>Final weekly hours</span>
                <input
                  type="text"
                  inputMode="decimal"
                  {...form.register('weeklyHours', {
                    required: 'Enter final weekly hours.',
                    validate: (value) => normalizeWeeklyHours(value).value !== null || 'Enter hours above 0 and no more than 40, to one decimal place.',
                  })}
                  aria-invalid={Boolean(form.formState.errors.weeklyHours)}
                  disabled={disabled}
                />
                {form.formState.errors.weeklyHours && <span className="field-error">{form.formState.errors.weeklyHours.message}</span>}
              </label>
            </>
          )}

          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={onToggle} disabled={disabled}>Keep request in queue</button>
            {canRecord && resolutionAction === 'record' && (
              <button type="submit" className="primary-button" disabled={disabled || form.formState.isSubmitting || (strategy === 'DEPRIORITIZE_OTHER_DEMANDS' && selections.initiatives.length === 0)}>
                {form.formState.isSubmitting ? 'Recording strategy…' : 'Record strategy'}
              </button>
            )}
            {canResolve && resolutionAction === 'resolve' && (
              <button type="submit" className="primary-button" disabled={disabled || form.formState.isSubmitting || eligiblePeople.length === 0 || eligibleProfiles.length === 0 || (strategy === 'DEPRIORITIZE_OTHER_DEMANDS' && selections.initiatives.length === 0)}>
                {form.formState.isSubmitting ? 'Resolving request…' : 'Resolve and approve'}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
