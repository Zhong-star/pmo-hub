import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';

const { mockedGet } = vi.hoisted(() => ({ mockedGet: vi.fn() }));

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
    const profileSelect = await screen.findByRole('combobox', { name: 'Local profile' });
    await userEvent.selectOptions(profileSelect, 'dev-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Avery Chen' })).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/hub/v1/local-users/dev-1');
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
});
