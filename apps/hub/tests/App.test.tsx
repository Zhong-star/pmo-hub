import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';
import { HUB_API_TIMEOUT_MS } from '../src/api';

const { mockedGet } = vi.hoisted(() => {
  const mockedGet = vi.fn();
  return { mockedGet };
});

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
});

describe('Hub entry', () => {
  it('validates a selected local profile before opening the initial experience', async () => {
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
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/local-users/dev-1', { timeout: HUB_API_TIMEOUT_MS });
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
    resolveValidation({ data: { id: 'dev-1', displayName: 'Avery Chen' } });
    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
  });
});
