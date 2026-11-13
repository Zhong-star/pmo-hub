import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';
import { HUB_API_TIMEOUT_MS } from '../src/api';
import { hubCatalogConfig } from '../src/catalog.config';

const { mockedGet } = vi.hoisted(() => {
  const mockedGet = vi.fn();
  return { mockedGet };
});
const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

vi.mock('axios', () => ({
  default: { create: () => ({ get: mockedGet }) },
}));

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockedGet.mockReset();
  try { window.localStorage.clear(); } catch { /* Storage may be disabled in the current test. */ }
  if (localStorageDescriptor) Object.defineProperty(window, 'localStorage', localStorageDescriptor);
});

describe('Hub entry', () => {
  it('uses the Hub header for profile selection and offers profile switching in the catalog menu', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const profileMenuButton = await screen.findByRole('button', { name: 'Avery Chen' });
    await userEvent.click(profileMenuButton);
    await userEvent.click(screen.getByRole('button', { name: 'Change profile' }));

    expect(await screen.findByRole('combobox', { name: 'Local profile' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Module catalog' })).not.toBeInTheDocument();
  });

  it('validates a selected local profile before showing the module catalog', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();

    expect(await screen.findByText('Hub available')).toBeInTheDocument();
    expect(Number.isFinite(HUB_API_TIMEOUT_MS)).toBe(true);
    expect(HUB_API_TIMEOUT_MS).toBeGreaterThan(0);
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/status', { timeout: HUB_API_TIMEOUT_MS });
    const profileSelect = await screen.findByRole('combobox', { name: 'Local profile' });
    await userEvent.selectOptions(profileSelect, 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByText('Capture, review, and reuse lessons from project experience.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Lessons Learned' })).toHaveAttribute('href', '/lessons-learned');
    expect(screen.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeInTheDocument();
    expect(screen.getByText('Request and coordinate technology resources across projects.')).toBeInTheDocument();
    const lessonsLearnedCard = screen.getByRole('link', { name: 'Open Lessons Learned' });
    expect(lessonsLearnedCard).toContainElement(screen.getByRole('heading', { name: 'Lessons Learned' }));
    expect(lessonsLearnedCard).toContainElement(screen.getByText('Capture, review, and reuse lessons from project experience.'));
    expect(lessonsLearnedCard).toContainElement(screen.getByText('Open Lessons Learned'));
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Tech Resource Allocation' })).not.toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/local-users/dev-1', { timeout: HUB_API_TIMEOUT_MS });
  });

  it('uses the catalog configuration to enable Lessons Learned and show Tech Resource Allocation as unavailable', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Tech Resource Allocation' })).toBeInTheDocument();
    const lessonsLearned = hubCatalogConfig.find((module) => module.code === 'lessons-learned');
    const resourceAllocation = hubCatalogConfig.find((module) => module.code === 'resource-allocation');
    expect(lessonsLearned?.enabled).toBe(true);
    expect(resourceAllocation?.enabled).toBe(false);
    expect(screen.getByRole('link', { name: 'Open Lessons Learned' })).toHaveAttribute('href', '/lessons-learned');
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tech Resource Allocation' }).parentElement?.querySelector('a, button')).toBeNull();
  });

  it('keeps entry blocked and offers retry when local profiles cannot be loaded', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users') && mockedGet.mock.calls.filter(([calledPath]) => calledPath === path).length === 1) {
        throw new Error('Connection failed');
      }
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent('Local profiles could not be loaded.');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Local profile' })).toBeInTheDocument());
  });

  it('keeps entry blocked and allows retry when profile validation times out', async () => {
    let validationAttempts = 0;
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) {
        validationAttempts += 1;
        if (validationAttempts === 1) throw Object.assign(new Error('timeout exceeded'), { code: 'ECONNABORTED' });
        return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The selected profile could not be validated.');
    expect(screen.queryByRole('heading', { name: 'Welcome, Avery Chen' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
  });

  it('locks the selected profile while validation is pending', async () => {
    let resolveValidation!: (response: { data: { id: string; displayName: string } }) => void;
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) {
        return new Promise((resolve) => { resolveValidation = resolve; });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();
    const profileSelect = await screen.findByRole('combobox', { name: 'Local profile' });
    await userEvent.selectOptions(profileSelect, 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(profileSelect).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Module catalog' })).not.toBeInTheDocument();
    resolveValidation({ data: { id: 'dev-1', displayName: 'Avery Chen' } });
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
  });

  it('resumes a saved profile only after validating it with the API', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'dev-1');
    let resolveValidation!: (response: { data: { id: string; displayName: string } }) => void;
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) {
        return new Promise((resolve) => { resolveValidation = resolve; });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();

    await waitFor(() => expect(resolveValidation).toBeDefined());
    expect(screen.queryByRole('heading', { name: 'Module catalog' })).not.toBeInTheDocument();
    resolveValidation({ data: { id: 'dev-1', displayName: 'Avery Chen' } });
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/local-users/dev-1', { timeout: HUB_API_TIMEOUT_MS });
    expect(window.localStorage.getItem('pmo-hub.local-user-id')).toBe('dev-1');
  });

  it('clears a removed saved profile and requires a new selection', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'gone');
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/gone')) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();

    expect(await screen.findByText('The saved profile no longer exists. Please select another local profile.')).toBeInTheDocument();
    expect(window.localStorage.getItem('pmo-hub.local-user-id')).toBeNull();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
  });

  it('lets the person change profile and saves only the newly validated identifier', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [
        { id: 'dev-1', displayName: 'Avery Chen' }, { id: 'dev-2', displayName: 'Jordan Lee' },
      ] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      if (path.endsWith('/dev-2')) return { data: { id: 'dev-2', displayName: 'Jordan Lee' } };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Avery Chen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Change profile' }));
    expect(window.localStorage.getItem('pmo-hub.local-user-id')).toBe('dev-1');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Jordan Lee' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Lessons Learned' })).toHaveAttribute('href', '/lessons-learned');
    expect(screen.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(window.localStorage.getItem('pmo-hub.local-user-id')).toBe('dev-2');
  });

  it('allows a validated profile when browser storage is unavailable', async () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: () => { throw new Error('Storage disabled'); },
      setItem: () => { throw new Error('Storage disabled'); },
      removeItem: () => { throw new Error('Storage disabled'); },
      clear: () => undefined,
    } });
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [{ id: 'dev-1', displayName: 'Avery Chen' }] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
  });

  it('does not automatically retry the saved profile after a manual selection fails', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'dev-1');
    const requestedProfiles: string[] = [];
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [
        { id: 'dev-1', displayName: 'Avery Chen' }, { id: 'dev-2', displayName: 'Jordan Lee' },
      ] };
      if (path.includes('/local-users/dev-')) {
        const userId = path.split('/').pop()!;
        requestedProfiles.push(userId);
        throw Object.assign(new Error('Unavailable'), { response: { status: 503 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    renderApp();
    expect(await screen.findByText('The saved profile could not be validated because the Hub is unavailable.')).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('The selected profile could not be validated. Check the Hub connection and try again.')).toBeInTheDocument();
    expect(requestedProfiles).toEqual(['dev-1', 'dev-2']);
  });

  it('revalidates the saved profile when the Hub catalog is restored from browser history', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'dev-1');
    let resolveContributor!: (response: { data: { id: string; displayName: string } }) => void;
    mockedGet.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) return { data: { status: 'available' } };
      if (path.endsWith('/local-users')) return { data: [
        { id: 'dev-1', displayName: 'Avery Chen' }, { id: 'dev-2', displayName: 'Jordan Lee' },
      ] };
      if (path.endsWith('/dev-1')) return { data: { id: 'dev-1', displayName: 'Avery Chen' } };
      if (path.endsWith('/dev-2')) {
        return new Promise((resolve) => { resolveContributor = resolve; });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderApp();
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();

    await act(async () => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'dev-2');
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(screen.queryByRole('heading', { name: 'Welcome, Avery Chen' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Validating profile…' })).toBeDisabled();
    await waitFor(() => expect(resolveContributor).toBeDefined());
    await act(async () => resolveContributor({ data: { id: 'dev-2', displayName: 'Jordan Lee' } }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Jordan Lee' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
  });
});
