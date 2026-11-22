import { hasNonBlankText } from './formValidation';
import { useForm } from 'react-hook-form';
import type { RequestQueueItem } from './requestQueueApi';
import { useNavigationFormProtection } from './NavigationProtection';

interface ExceptionStageActionProps {
  item: RequestQueueItem;
  action: 'escalate' | 'cancel';
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onSubmit: (reason: string) => Promise<void>;
}

interface ReasonValues { reason: string; }

export function ExceptionStageAction({ item, action, disabled, open, onToggle, onSubmit }: ExceptionStageActionProps) {
  const form = useForm<ReasonValues>({ defaultValues: { reason: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const guardFormClose = useNavigationFormProtection('exception stage action', form.formState.isDirty, form.formState.isSubmitting);
  const title = action === 'escalate' ? 'Escalate this exception' : 'Cancel this request';
  const buttonLabel = action === 'escalate' ? 'Escalate request' : 'Cancel request';
  const submitLabel = action === 'escalate' ? 'Confirm escalation' : 'Confirm cancellation';
  const progressLabel = action === 'escalate' ? 'Escalating…' : 'Cancelling…';
  const copy = action === 'escalate'
    ? 'This explicitly moves the request from Pre N3 to Escalation. It will remain open for Admin resolution.'
    : `Cancellation is final. The request history will remain available. Current stage: ${item.decisionState.replaceAll('_', ' ')}.`;

  function toggleAction() {
    if (!open) {
      onToggle();
      return;
    }
    guardFormClose(() => {
      form.reset({ reason: '' });
      onToggle();
    });
  }

  return (
    <div className="request-exception-stage-action">
      {!open && (
        <button type="button" className="secondary-button" aria-expanded="false" onClick={toggleAction} disabled={disabled}>
          {buttonLabel}
        </button>
      )}
      {open && (
        <form
          className="request-queue-action-form"
          aria-label={`${action === 'escalate' ? 'Escalate exception' : 'Cancel exception'} ${item.id}`}
          onSubmit={form.handleSubmit(async ({ reason }) => onSubmit(reason.trim()))}
        >
          <h4>{title}</h4>
          <p>{copy}</p>
          <label className="form-field request-queue-reason-field">
            <span>Reason</span>
            <textarea
              maxLength={2000}
              aria-invalid={Boolean(form.formState.errors.reason)}
              {...form.register('reason', {
                required: 'Provide a reason.',
                validate: (value) => hasNonBlankText(value) || 'Provide a reason.',
              })}
              disabled={disabled}
            />
            <span className="field-help">Required · up to 2,000 characters.</span>
            {form.formState.errors.reason && <span className="field-error">{form.formState.errors.reason.message}</span>}
          </label>
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={toggleAction} disabled={disabled}>Keep request in queue</button>
            <button type="submit" className={action === 'cancel' ? 'secondary-button' : 'primary-button'} disabled={disabled || form.formState.isSubmitting}>
              {form.formState.isSubmitting ? progressLabel : submitLabel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
