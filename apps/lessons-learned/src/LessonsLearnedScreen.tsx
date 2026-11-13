import { useQuery } from '@tanstack/react-query';
import { getHealth } from './api';

export function LessonsLearnedScreen() {
  const healthQuery = useQuery({
    queryKey: ['lessons-learned-health'],
    queryFn: getHealth,
  });

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="hub-link" href="/" aria-label="PMO Hub">
          <span aria-hidden="true">←</span>
          <span>PMO Hub</span>
        </a>
      </header>

      <section className="module-card" aria-labelledby="page-title">
        <p className="eyebrow">Project delivery</p>
        <h1 id="page-title">Lessons Learned</h1>
        <p className="intro">Capture and share the experience gained across your projects.</p>

        {healthQuery.isPending && (
          <div className="api-status" role="status" aria-live="polite">
            <span className="status-indicator is-checking" aria-hidden="true" />
            <span>Checking API availability</span>
          </div>
        )}

        {healthQuery.isSuccess && (
          <div className="api-status" role="status" aria-live="polite">
            <span className="status-indicator is-available" aria-hidden="true" />
            <span>API available</span>
          </div>
        )}

        {healthQuery.isError && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <strong>API unavailable</strong>
              <p>The Lessons Learned screen is open, but its service could not be reached.</p>
              <button className="retry-button" type="button" onClick={() => void healthQuery.refetch()}>
                Try again
              </button>
            </div>
          </div>
        )}

      </section>
    </main>
  );
}
