import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { getHubStatus, getLocalUser, getLocalUsers, type LocalUser } from './api';
import { hubCatalogConfig } from './catalog.config';

const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';

function readSavedUserId(): string | null {
  try { return window.localStorage.getItem(LOCAL_USER_STORAGE_KEY); } catch { return null; }
}

function saveUserId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(LOCAL_USER_STORAGE_KEY, id);
    else window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY);
  } catch { /* Storage is best-effort; the current session can still continue. */ }
}

export function App() {
  const { register, handleSubmit, control, reset } = useForm<{ localUserId: string }>({
    defaultValues: { localUserId: '' },
  });
  const selectedId = useWatch({ control, name: 'localUserId' });
  const [activeUser, setActiveUser] = useState<LocalUser | null>(null);
  const [savedUserId, setSavedUserId] = useState(readSavedUserId);
  const [resumeError, setResumeError] = useState<'missing' | 'unavailable' | null>(null);
  const [switching, setSwitching] = useState(false);
  const shouldResumeOnStartup = useRef(true);

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
  });

  useEffect(() => {
    if (shouldResumeOnStartup.current && savedUserId && statusQuery.isSuccess && usersQuery.isSuccess && !selectUserMutation.isPending && !selectUserMutation.isSuccess && !resumeError) {
      shouldResumeOnStartup.current = false;
      selectUserMutation.mutate(savedUserId, {
        onSuccess: (user) => { saveUserId(user.id); setActiveUser(user); },
        onError: (error) => {
          if (isNotFound(error)) { saveUserId(null); setSavedUserId(null); setResumeError('missing'); }
          else setResumeError('unavailable');
        },
      });
    }
  // Resume once after Hub availability is confirmed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedUserId, statusQuery.isSuccess, usersQuery.isSuccess, resumeError]);

  function isNotFound(error: unknown) {
    return typeof error === 'object' && error !== null && 'response' in error &&
      typeof error.response === 'object' && error.response !== null && 'status' in error.response && error.response.status === 404;
  }

  function retry() {
    if (statusQuery.isError) {
      void statusQuery.refetch();
      return;
    }
    if (usersQuery.isError) {
      void usersQuery.refetch();
      return;
    }
    if (resumeError === 'unavailable' && savedUserId && !selectUserMutation.isPending) {
      selectUserMutation.mutate(savedUserId, {
        onSuccess: (user) => { saveUserId(user.id); setActiveUser(user); setResumeError(null); },
        onError: (error) => { if (isNotFound(error)) { saveUserId(null); setSavedUserId(null); setResumeError('missing'); } else setResumeError('unavailable'); },
      });
      return;
    }
    selectUserMutation.reset();
    if (selectedId && !selectUserMutation.isPending) validateManualSelection(selectedId);
  }

  function validateManualSelection(userId: string) {
    if (switching && userId === savedUserId) return;
    shouldResumeOnStartup.current = false;
    selectUserMutation.mutate(userId, {
      onSuccess: (user) => { saveUserId(user.id); setSavedUserId(user.id); setSwitching(false); setActiveUser(user); setResumeError(null); },
      onError: () => setResumeError(null),
    });
  }

  function changeProfile() {
    shouldResumeOnStartup.current = false;
    setSwitching(true);
    setActiveUser(null);
    reset({ localUserId: '' });
    selectUserMutation.reset();
    setResumeError(null);
  }

  const isLoading = statusQuery.isPending || (statusQuery.isSuccess && usersQuery.isPending);
  const isResuming = (selectUserMutation.isPending && selectUserMutation.variables === savedUserId) || resumeError === 'unavailable';
  const loadError = statusQuery.error ?? usersQuery.error;

  return (
    <main className="page-shell">
      <section className={`welcome-card${activeUser ? ' catalog-page' : ''}`} aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">P</div>
        <p className="eyebrow">Project Management Office</p>
        <h1 id="page-title">Welcome to PMO Hub</h1>
        <p className="intro">Your starting point for the tools and experience that support project delivery.</p>

        <div className="service-status" role="status" aria-live="polite">
          <span className={`status-dot ${statusQuery.isSuccess ? 'is-available' : ''}`} aria-hidden="true" />
          <span>{statusQuery.isSuccess && resumeError !== 'unavailable' ? 'Hub available' : statusQuery.isError || resumeError === 'unavailable' ? 'Hub unavailable' : 'Checking Hub availability…'}</span>
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

            {resumeError === 'missing' && <p className="message message-info" role="status">The saved profile no longer exists. Please select another local profile.</p>}
            {resumeError === 'unavailable' && <div className="message message-error" role="alert"><p>The saved profile could not be validated because the Hub is unavailable.</p><button className="button button-secondary" type="button" disabled={selectUserMutation.isPending} onClick={retry}>Try again</button></div>}

            {statusQuery.isSuccess && usersQuery.isSuccess && usersQuery.data.length === 0 && (
              <p className="message message-info" role="status">
                No local profiles are configured. Ask your development environment owner to prepare a local user.
              </p>
            )}

            {statusQuery.isSuccess && usersQuery.isSuccess && usersQuery.data.length > 0 && (
              <form onSubmit={handleSubmit(({ localUserId }) => validateManualSelection(localUserId))}>
                <label htmlFor="local-profile">Local profile</label>
                <select
                  id="local-profile"
                  disabled={selectUserMutation.isPending}
                  {...register('localUserId', { required: true, onChange: () => { selectUserMutation.reset(); setResumeError(null); shouldResumeOnStartup.current = false; } })}
                >
                  <option value="" disabled>Select a profile</option>
                  {usersQuery.data.map((user) => (
                    <option key={user.id} value={user.id}>{user.displayName}</option>
                  ))}
                </select>
                {selectUserMutation.isError && !isResuming && resumeError !== 'missing' && (
                  <div className="message message-error" role="alert">
                    <p>The selected profile could not be validated. Check the Hub connection and try again.</p>
                    <button className="text-button" type="button" onClick={retry}>Try again</button>
                  </div>
                )}
                <button className="button button-primary" type="submit" disabled={!selectedId || selectUserMutation.isPending || (switching && selectedId === savedUserId)}>
                  {selectUserMutation.isPending ? 'Validating profile…' : 'Continue'}
                </button>
              </form>
            )}
          </div>
        )}

        {activeUser && (
          <>
            <div className="profile-bar" aria-live="polite">
              <div>
                <p className="eyebrow">Your local profile</p>
                <h2>Welcome, {activeUser.displayName}</h2>
              </div>
              <button className="button button-secondary" type="button" onClick={changeProfile}>Change profile</button>
            </div>

            <section className="module-catalog" aria-labelledby="catalog-title">
              <div className="catalog-header">
                <h2 id="catalog-title">Module catalog</h2>
                <p className="helper-text">Explore the modules available through PMO Hub.</p>
              </div>
              <ul className="module-grid">
                {hubCatalogConfig.map((module) => (
                  <li key={module.code} className="module-card">
                    <article aria-labelledby={`catalog-${module.code}-title`}>
                      <h3 id={`catalog-${module.code}-title`}>{module.name}</h3>
                      <p>{module.description}</p>
                      <button
                        className="button button-secondary module-action"
                        type="button"
                        disabled
                        aria-label={`${module.name}: Coming soon`}
                      >
                        Coming soon
                      </button>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </section>
      <footer>PMO Hub · Local development</footer>
    </main>
  );
}
