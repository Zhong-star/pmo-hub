import { useEffect, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { getHome } from './api';

const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';
const THEME_STORAGE_KEY = 'pmo-hub.lessons-learned.theme';

type Theme = 'light' | 'dark';

function readThemePreference(): Theme {
  try {
    return window.sessionStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readSelectedProfileId(): string | null {
  try {
    const id = window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)?.trim();
    return id || null;
  } catch {
    return null;
  }
}

function getApiErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

function getRoleLabel(role: 'LESSONS_USER' | 'LESSONS_MODERATOR'): string {
  return role === 'LESSONS_MODERATOR' ? 'PMO' : 'Contributor';
}

export function LessonsLearnedScreen() {
  const [selectedProfileId, setSelectedProfileId] = useState(readSelectedProfileId);
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
  const homeQuery = useQuery({
    queryKey: ['lessons-learned-home', selectedProfileId],
    queryFn: () => getHome(selectedProfileId ?? ''),
    enabled: selectedProfileId !== null,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const errorCode = homeQuery.isError ? getApiErrorCode(homeQuery.error) : null;
  const isHomePage = selectedProfileId !== null && !homeQuery.isFetching && homeQuery.isSuccess && !homeQuery.isError;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function selectTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    try {
      window.sessionStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Keep the current selection for this render if browser storage is unavailable.
    }
  }

  useEffect(() => {
    function updateSelectedProfile(event: StorageEvent) {
      if (event.key === null || event.key === LOCAL_USER_STORAGE_KEY) {
        setSelectedProfileId(readSelectedProfileId());
      }
    }

    function restoreSelectedProfile() {
      setSelectedProfileId(readSelectedProfileId());
    }

    window.addEventListener('storage', updateSelectedProfile);
    window.addEventListener('pageshow', restoreSelectedProfile);
    return () => {
      window.removeEventListener('storage', updateSelectedProfile);
      window.removeEventListener('pageshow', restoreSelectedProfile);
    };
  }, []);

  function changeProfile() {
    try {
      window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY);
    } catch {
      // The Hub still presents profile selection when browser storage is unavailable.
    }
    setSelectedProfileId(null);
    window.location.assign('/');
  }

  return (
    <div className="app-shell">
      <HubHeader
        profileName={homeQuery.data?.profile.displayName ?? selectedProfileId ?? undefined}
        onChangeProfile={selectedProfileId ? changeProfile : undefined}
      />
      <main className="page-shell">
      <section
        className={isHomePage ? 'module-card module-card-with-navigation' : 'module-card'}
        aria-labelledby="page-title"
      >
        <p className="eyebrow">Lessons Learned</p>

        {!selectedProfileId && (
          <>
            <h1 id="page-title">Access check</h1>
            <p className="intro">No local profile is selected. Return to PMO Hub and select a profile to continue.</p>
            <a className="primary-link" href="/">Select a local profile</a>
          </>
        )}

        {selectedProfileId && homeQuery.isFetching && (
          <>
            <h1 id="page-title">Access check</h1>
            <p className="intro">Lessons Learned verifies your local profile before opening Home.</p>
            <div className="api-status" role="status" aria-live="polite">
              <span className="status-indicator is-checking" aria-hidden="true" />
              <span>Checking access for <strong>{selectedProfileId}</strong></span>
            </div>
          </>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && errorCode === 'ACCESS_DENIED' && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access denied</h1>
              <p>Your local profile does not have access to Lessons Learned. Contact the PMO if you need access.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && (
          errorCode === 'ACCESS_CONFIGURATION_ERROR' || errorCode === 'LOCAL_AUTH_DISABLED'
        ) && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access configuration error</h1>
              <p>The Lessons Learned access configuration is invalid. Contact the responsible team.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && errorCode !== 'ACCESS_DENIED' &&
          errorCode !== 'ACCESS_CONFIGURATION_ERROR' && errorCode !== 'LOCAL_AUTH_DISABLED' && (
            <div className="api-status unavailable" role="alert" aria-live="assertive">
              <span className="status-indicator is-unavailable" aria-hidden="true" />
              <div>
                <h1 id="page-title">Access check temporarily unavailable</h1>
                <p>The API could not complete the access check. Retry to continue.</p>
                <button className="retry-button" type="button" onClick={() => void homeQuery.refetch()}>
                  Retry
                </button>
              </div>
            </div>
          )}

        {isHomePage && (
          <div className="module-layout">
            <aside
              className="module-sidebar"
              aria-label="Lessons Learned navigation"
              data-menu-open={isModuleMenuOpen}
            >
              <button
                className="module-menu-toggle"
                type="button"
                aria-controls="module-navigation"
                aria-expanded={isModuleMenuOpen}
                onClick={() => setIsModuleMenuOpen((isOpen) => !isOpen)}
              >
                Module menu
              </button>
              <nav id="module-navigation" className="module-navigation" aria-label="Lessons Learned">
                {homeQuery.data.navigation.map((destination) => (
                  <a
                    key={destination.id}
                    href="/lessons-learned/"
                    aria-current={destination.current ? 'page' : undefined}
                    onClick={() => setIsModuleMenuOpen(false)}
                  >
                    {destination.label}
                  </a>
                ))}
              </nav>
              <div className="theme-controls" role="group" aria-label="Color theme">
                <button
                  type="button"
                  aria-pressed={theme === 'light'}
                  onClick={() => selectTheme('light')}
                >
                  Light
                </button>
                <button
                  type="button"
                  aria-pressed={theme === 'dark'}
                  onClick={() => selectTheme('dark')}
                >
                  Dark
                </button>
              </div>
            </aside>
            <div className="module-content">
              <h1 id="page-title">Home</h1>
              <p className="intro">Welcome, {homeQuery.data.profile.displayName}</p>
              <p className="active-role">Active role: <strong>{getRoleLabel(homeQuery.data.profile.role)}</strong></p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}
      </section>
      </main>
    </div>
  );
}
