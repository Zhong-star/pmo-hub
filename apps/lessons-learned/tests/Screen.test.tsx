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

function renderScreen(localUserId?: string, gcTime = 0) {
  window.localStorage.clear();
  if (localUserId) window.localStorage.setItem('pmo-hub.local-user-id', localUserId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime } },
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

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
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

  it('opens the module menu with the keyboard and closes it after choosing Home', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    const user = userEvent.setup();

    renderScreen('local-contributor');

    const menuButton = await screen.findByRole('button', { name: 'Module menu' });
    const navigation = screen.getByRole('navigation', { name: 'Lessons Learned' });
    const homeLink = screen.getByRole('link', { name: 'Home' });

    expect(menuButton).toHaveAttribute('aria-controls', 'module-navigation');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(homeLink).toHaveAttribute('href', '/lessons-learned/');
    expect(navigation).toHaveAttribute('id', 'module-navigation');

    menuButton.focus();
    await user.keyboard('{Enter}');
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Enter}');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    homeLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await user.click(homeLink);

    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('switches the sidebar theme from the keyboard and keeps the choice in this session', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    const user = userEvent.setup();
    const view = renderScreen('local-contributor');

    await screen.findByRole('navigation', { name: 'Lessons Learned' });
    const lightTheme = screen.getByRole('button', { name: 'Light' });
    const darkTheme = screen.getByRole('button', { name: 'Dark' });
    expect(lightTheme).toHaveAttribute('aria-pressed', 'true');
    expect(darkTheme).toHaveAttribute('aria-pressed', 'false');

    screen.getByRole('link', { name: 'Home' }).focus();
    await user.tab();
    await user.tab();
    expect(darkTheme).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(darkTheme).toHaveAttribute('aria-pressed', 'true');
    expect(lightTheme).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.sessionStorage.getItem('pmo-hub.lessons-learned.theme')).toBe('dark');

    view.unmount();
    renderScreen('local-contributor');
    await screen.findByRole('navigation', { name: 'Lessons Learned' });
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
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
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'local-no-access' })).toBeInTheDocument();
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

  it('shows one Access check title while a cached profile is being revalidated', async () => {
    let resolveContributorAgain!: (value: typeof contributor) => void;
    vi.mocked(getHome).mockImplementation((localUserId) => {
      if (localUserId === 'local-pmo') return Promise.resolve(pmo);
      if (vi.mocked(getHome).mock.calls.filter(([id]) => id === 'local-contributor').length === 1) {
        return Promise.resolve(contributor);
      }
      return new Promise((resolve) => { resolveContributorAgain = resolve; });
    });

    renderScreen('local-contributor', 60_000);
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-pmo' }));
    });
    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-contributor' }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Access check' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local PMO')).not.toBeInTheDocument();

    resolveContributorAgain(contributor);
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
