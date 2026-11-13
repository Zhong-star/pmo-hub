import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import { getHome } from '../src/api';

vi.mock('../src/api', () => ({
  getHome: vi.fn(),
}));

const contributor = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

const pmo = {
  profile: { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

function renderScreen(localUserId?: string) {
  window.localStorage.clear();
  if (localUserId) window.localStorage.setItem('pmo-hub.local-user-id', localUserId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

function apiError(status: number, code: string) {
  return Object.assign(new Error('Request failed'), { response: { status, data: { code } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('Lessons Learned access check', () => {
  it('returns to the Hub profile selector when no local profile is selected', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'Access check' })).toBeInTheDocument();
    expect(screen.getByText(/No local profile is selected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');
    expect(getHome).not.toHaveBeenCalled();
  });

  it('shows the selected identity while the API checks access without showing Home data', () => {
    vi.mocked(getHome).mockReturnValue(new Promise(() => undefined));

    renderScreen('local-contributor');

    expect(screen.getByRole('heading', { name: 'Access check' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledWith('local-contributor');
  });

  it('opens Home for Contributor only after API authorization', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);

    renderScreen('local-contributor');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Welcome, Local Contributor')).toBeInTheDocument();
    expect(screen.getByText('Contributor', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Lessons Learned navigation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Back to PMO Hub' })).toHaveAttribute('href', '/');
  });

  it('shows the PMO role returned by the API', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);

    renderScreen('local-pmo');

    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();
    expect(screen.getByText('PMO', { selector: 'strong' })).toBeInTheDocument();
  });

  it('denies a profile without access and recommends contacting the PMO', async () => {
    vi.mocked(getHome).mockRejectedValue(apiError(403, 'ACCESS_DENIED'));

    renderScreen('local-no-access');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText(/Contact the PMO/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
  });

  it('shows a configuration error for a duplicate or invalid module profile', async () => {
    vi.mocked(getHome).mockRejectedValue(apiError(500, 'ACCESS_CONFIGURATION_ERROR'));

    renderScreen('local-pmo');

    expect(await screen.findByRole('heading', { name: 'Access configuration error' })).toBeInTheDocument();
    expect(screen.getByText(/Contact the responsible team/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('retries a temporary access-check failure and opens Home after recovery', async () => {
    vi.mocked(getHome)
      .mockRejectedValueOnce(new Error('API unavailable'))
      .mockResolvedValueOnce(contributor);

    renderScreen('local-contributor');

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it('revalidates Home when the tab regains focus and hides data after access is revoked', async () => {
    vi.mocked(getHome)
      .mockResolvedValueOnce(contributor)
      .mockRejectedValueOnce(apiError(403, 'ACCESS_DENIED'));

    renderScreen('local-contributor');
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it('does not keep the previous profile Home visible while a changed profile is checked', async () => {
    let resolvePmo!: (value: typeof pmo) => void;
    let resolveContributorAgain!: (value: typeof contributor) => void;
    let contributorRequests = 0;
    vi.mocked(getHome).mockImplementation((localUserId) => {
      if (localUserId === 'local-contributor') {
        contributorRequests += 1;
        if (contributorRequests === 1) return Promise.resolve(contributor);
        return new Promise((resolve) => { resolveContributorAgain = resolve; });
      }
      return new Promise((resolve) => { resolvePmo = resolve; });
    });

    renderScreen('local-contributor');
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-pmo',
      }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-pmo');
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    resolvePmo(pmo);
    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-contributor',
      }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByText('Welcome, Local PMO')).not.toBeInTheDocument();
    resolveContributorAgain(contributor);
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
  });
});
