import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { getHubStatus, getLocalUser, getLocalUsers, type LocalUser } from './api';

export function App() {
  const { register, handleSubmit, control } = useForm<{ localUserId: string }>({
    defaultValues: { localUserId: '' },
  });
  const selectedId = useWatch({ control, name: 'localUserId' });
  const [activeUser, setActiveUser] = useState<LocalUser | null>(null);

  const statusQuery = useQuery({
    queryKey: ['hub-status'],
    queryFn: getHubStatus,
  });
  const usersQuery = useQuery({
    queryKey: ['local-users'],
    queryFn: getLocalUsers,
    enabled: statusQuery.isSuccess,
  });
  const selectUserMutation = useMutation({
    mutationFn: getLocalUser,
    onSuccess: (user) => setActiveUser(user),
  });

  function retry() {
    if (statusQuery.isError) {
      void statusQuery.refetch();
      return;
    }
    if (usersQuery.isError) {
      void usersQuery.refetch();
      return;
    }
    selectUserMutation.reset();
    if (selectedId) selectUserMutation.mutate(selectedId);
  }

  const isLoading = statusQuery.isPending || (statusQuery.isSuccess && usersQuery.isPending);
  const loadError = statusQuery.error ?? usersQuery.error;

  return (
    <main className="page-shell">
      <section className="welcome-card" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">P</div>
        <p className="eyebrow">Project Management Office</p>
        <h1 id="page-title">Welcome to PMO Hub</h1>
        <p className="intro">Your starting point for the tools and experience that support project delivery.</p>

        <div className="service-status" role="status" aria-live="polite">
          <span className={`status-dot ${statusQuery.isSuccess ? 'is-available' : ''}`} aria-hidden="true" />
          <span>{statusQuery.isSuccess ? 'Hub available' : statusQuery.isError ? 'Hub unavailable' : 'Checking Hub availability…'}</span>
        </div>

        {!activeUser && (
          <div className="entry-panel">
            <h2>Select your local profile</h2>
            <p className="helper-text">Choose a prepared local user to continue.</p>

            {isLoading && <p role="status">Loading local profiles…</p>}

            {loadError && (
              <div className="message message-error" role="alert">
                <p>{statusQuery.isError ? 'The Hub could not be reached.' : 'Local profiles could not be loaded.'}</p>
                <button className="button button-secondary" type="button" onClick={retry}>
                  Try again
                </button>
              </div>
            )}

            {statusQuery.isSuccess && usersQuery.isSuccess && usersQuery.data.length === 0 && (
              <p className="message message-info" role="status">
                No local profiles are configured. Ask your development environment owner to prepare a local user.
              </p>
            )}

            {statusQuery.isSuccess && usersQuery.isSuccess && usersQuery.data.length > 0 && (
              <form onSubmit={handleSubmit(({ localUserId }) => selectUserMutation.mutate(localUserId))}>
                <label htmlFor="local-profile">Local profile</label>
                <select
                  id="local-profile"
                  disabled={selectUserMutation.isPending}
                  {...register('localUserId', { required: true, onChange: () => selectUserMutation.reset() })}
                >
                  <option value="" disabled>Select a profile</option>
                  {usersQuery.data.map((user) => (
                    <option key={user.id} value={user.id}>{user.displayName}</option>
                  ))}
                </select>
                {selectUserMutation.isError && (
                  <div className="message message-error" role="alert">
                    <p>The selected profile could not be validated. Check the Hub connection and try again.</p>
                    <button className="text-button" type="button" onClick={retry}>Try again</button>
                  </div>
                )}
                <button className="button button-primary" type="submit" disabled={!selectedId || selectUserMutation.isPending}>
                  {selectUserMutation.isPending ? 'Validating profile…' : 'Continue'}
                </button>
              </form>
            )}
          </div>
        )}

        {activeUser && (
          <div className="entry-panel home-panel" aria-live="polite">
            <p className="eyebrow">Your local profile</p>
            <h2>Welcome, {activeUser.displayName}</h2>
            <p className="helper-text">Your Hub profile is ready.</p>
          </div>
        )}
      </section>
      <footer>PMO Hub · Local development</footer>
    </main>
  );
}
