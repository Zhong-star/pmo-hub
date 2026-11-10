import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const originalEnabledValues = new Map(hubCatalogConfig.map((module) => [module, module.enabled]));

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
  originalEnabledValues.forEach((enabled, module) => { module.enabled = enabled; });
  try { window.localStorage.clear(); } catch { /* Storage may be disabled in the current test. */ }
  if (localStorageDescriptor) Object.defineProperty(window, 'localStorage', localStorageDescriptor);
});

describe('Hub entry', () => {
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
    expect(screen.getByRole('button', { name: 'Lessons Learned: Coming soon' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeInTheDocument();
    expect(screen.getByText('Request and coordinate technology resources across projects.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /Lessons Learned|Tech Resource Allocation/ })).not.toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/local-users/dev-1', { timeout: HUB_API_TIMEOUT_MS });
  });

  it('shows module readiness from a mixed Hub configuration without making enabled modules interactive', async () => {
    const enabledModule = hubCatalogConfig.find((module) => module.code === 'resource-allocation');
    if (!enabledModule) throw new Error('Resource Allocation module configuration is missing.');
    enabledModule.enabled = true;

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
    const enabledModuleCard = screen.getByRole('heading', { name: 'Tech Resource Allocation' }).closest('article');
    expect(enabledModuleCard).not.toBeNull();
    expect(within(enabledModuleCard!).getByRole('status')).toHaveTextContent('Ready to open');
    expect(screen.getByRole('button', { name: 'Lessons Learned: Coming soon' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Tech Resource Allocation: Ready to open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tech Resource Allocation: Ready to open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Lessons Learned|Tech Resource Allocation/ })).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Change profile' }));
    expect(window.localStorage.getItem('pmo-hub.local-user-id')).toBe('dev-1');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Local profile' }), 'dev-2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Jordan Lee' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Module catalog' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lessons Learned: Coming soon' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Tech Resource Allocation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tech Resource Allocation: Coming soon' })).toBeDisabled();
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
});
