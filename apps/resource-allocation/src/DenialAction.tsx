import { hasNonBlankText } from './formValidation';
import { useForm } from 'react-hook-form';
import type { RequestQueueItem } from './requestQueueApi';

interface DenialActionProps {
  item: RequestQueueItem;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onSubmit: (explanation: string) => Promise<void>;
}

interface DenialValues { explanation: string; }

export function DenialAction({ item, disabled, open, onToggle, onSubmit }: DenialActionProps) {
  const form = useForm<DenialValues>({ defaultValues: { explanation: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });

  const isBlocked = disabled || form.formState.isSubmitting;

  return (
    <div className="request-denial-action">
      {!open && (
        <button type="button" className="secondary-button" aria-expanded="false" onClick={onToggle} disabled={isBlocked}>
          Deny request
        </button>
      )}
      {open && (
        <form className="request-queue-action-form" aria-label={`Deny request ${item.id}`} onSubmit={form.handleSubmit(async ({ explanation }) => onSubmit(explanation.trim()))}>
          <h4>Deny this request</h4>
          <p>The requester will receive your explanation and may contest within 14 days.</p>
          <label className="form-field">
            <span>Explanation for denial</span>
            <textarea
              maxLength={2000}
              disabled={isBlocked}
              aria-invalid={Boolean(form.formState.errors.explanation)}
              {...form.register('explanation', {
                required: 'Enter an explanation before denying the request.',
                validate: (value) => hasNonBlankText(value) || 'Enter an explanation before denying the request.',
              })}
            />
            <span className="field-help">Required · up to 2,000 characters.</span>
            {form.formState.errors.explanation?.message && <span className="field-error">{form.formState.errors.explanation.message}</span>}
          </label>
          <div className="form-actions request-queue-action-buttons">
            <button type="button" className="secondary-button" onClick={onToggle} disabled={isBlocked}>Keep request in queue</button>
            <button type="submit" className="primary-button" disabled={isBlocked}>
              {form.formState.isSubmitting ? 'Denying…' : 'Confirm denial'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
