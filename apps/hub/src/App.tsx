import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { WorkspaceSidebar } from '../../shared-ui/src/WorkspaceSidebar';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import {
  ArrowRightIcon,
  BookOpenIcon,
  BriefcaseIcon,
  LayersIcon,
  UserIcon,
} from '../../shared-ui/src/Icons';
import { useThemePreference } from '../../shared-ui/src/theme';
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

function moduleIcon(code: string, size = 18) {
  if (code === 'lessons-learned') return <BookOpenIcon size={size} />;
  if (code === 'resource-allocation') return <BriefcaseIcon size={size} />;
  return <LayersIcon size={size} />;
}

export function App() {
  const { theme, selectTheme } = useThemePreference();
  const { register, handleSubmit, control, reset } = useForm<{ localUserId: string }>({
    defaultValues: { localUserId: '' },
  });
  const selectedId = useWatch({ control, name: 'localUserId' });
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
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
  const resetSelectionMutation = selectUserMutation.reset;

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

  useEffect(() => {
    function reconcileSavedProfile() {
      const currentSavedUserId = readSavedUserId();
      if (currentSavedUserId === savedUserId) return;

      shouldResumeOnStartup.current = Boolean(currentSavedUserId);
      setActiveUser(null);
      setSavedUserId(currentSavedUserId);
      setResumeError(null);
      setSwitching(false);
      reset({ localUserId: '' });
      resetSelectionMutation();
    }

    window.addEventListener('pageshow', reconcileSavedProfile);
    return () => window.removeEventListener('pageshow', reconcileSavedProfile);
  }, [savedUserId, reset, resetSelectionMutation]);

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
    setIsModuleMenuOpen(false);
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
    <div className={activeUser ? 'page-shell workspace-shell' : 'page-shell'}>
      <HubHeader
        profileName={activeUser?.displayName}
        onChangeProfile={activeUser ? changeProfile : undefined}
        theme={theme}
        onThemeChange={selectTheme}
      />
      <div className={activeUser ? 'workspace-layout' : 'entry-layout'}>
        {activeUser && (
          <WorkspaceSidebar
            label="Hub navigation"
            navigationLabel="Available modules"
            navigationId="hub-module-navigation"
            open={isModuleMenuOpen}
            onToggle={() => setIsModuleMenuOpen((open) => !open)}
          >
            {hubCatalogConfig.filter((module) => module.enabled).map((module) => (
              <a key={module.code} href={module.route} onClick={() => setIsModuleMenuOpen(false)}>
                {moduleIcon(module.code, 17)}
                <span>{module.name}</span>
              </a>
            ))}
          </WorkspaceSidebar>
        )}
        <main className={activeUser ? 'workspace-panel' : 'page-content'} tabIndex={activeUser ? 0 : undefined}>
          <section className={`welcome-card${activeUser ? ' catalog-page' : ''}`} aria-labelledby="page-title">
            <h1 id="page-title" className={activeUser ? 'sr-only' : undefined}>Welcome to PMO Hub</h1>

            {activeUser ? (
              <div className="hub-workspace-header">
                <div className="profile-bar" aria-live="polite">
                  <h2>Welcome, {activeUser.displayName}</h2>
                </div>
                <div className="service-status" role="status" aria-live="polite">
                  <span className={`status-dot ${statusQuery.isSuccess ? 'is-available' : ''}`} aria-hidden="true" />
                  <span>{statusQuery.isSuccess && resumeError !== 'unavailable' ? 'Hub available' : statusQuery.isError || resumeError === 'unavailable' ? 'Hub unavailable' : 'Checking Hub availability…'}</span>
                </div>
              </div>
            ) : (
              <div className="service-status" role="status" aria-live="polite">
                <span className={`status-dot ${statusQuery.isSuccess ? 'is-available' : ''}`} aria-hidden="true" />
                <span>{statusQuery.isSuccess && resumeError !== 'unavailable' ? 'Hub available' : statusQuery.isError || resumeError === 'unavailable' ? 'Hub unavailable' : 'Checking Hub availability…'}</span>
              </div>
            )}

            {!activeUser && (
              <div className="entry-panel">
                <h2 className="entry-panel__heading">
                  <UserIcon size={18} />
                  <span>Select your local profile</span>
                </h2>

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
                    <button className="button button-primary ui-inline-btn" type="submit" disabled={!selectedId || selectUserMutation.isPending || (switching && selectedId === savedUserId)}>
                      <span>{selectUserMutation.isPending ? 'Validating profile…' : 'Continue'}</span>
                      <ArrowRightIcon size={16} />
                    </button>
                  </form>
                )}
              </div>
            )}

            {activeUser && (
              <section className="module-catalog" aria-labelledby="catalog-title">
                <h2 id="catalog-title" className="catalog-title">Module catalog</h2>
                <ul className="module-grid">
                  {hubCatalogConfig.map((module) => {
                    const article = (
                      <article aria-labelledby={`catalog-${module.code}-title`}>
                        <div className={`module-card__icon${module.enabled ? '' : ' is-unavailable'}`} aria-hidden="true">
                          {moduleIcon(module.code, 20)}
                        </div>
                        <h3 id={`catalog-${module.code}-title`}>{module.name}</h3>
                        <p>{module.description}</p>
                        {module.enabled ? (
                          <span className="module-action">
                            <span>Open {module.name}</span>
                            <ArrowRightIcon size={15} />
                          </span>
                        ) : (
                          <span className="module-status">Unavailable</span>
                        )}
                      </article>
                    );

                    return (
                      <li key={module.code} className={`module-card${module.enabled ? ' module-card-linked' : ''}`}>
                        {module.enabled ? (
                          <a className="module-card-link" href={module.route} aria-label={`Open ${module.name}`}>
                            {article}
                          </a>
                        ) : article}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </section>
          <footer>Local development</footer>
        </main>
      </div>
    </div>
  );
}
