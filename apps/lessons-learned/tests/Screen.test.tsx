import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import { getHealth } from '../src/api';

vi.mock('../src/api', () => ({
  getHealth: vi.fn(),
}));

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

describe('Lessons Learned technical screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the screen and an accessible loading status while checking the API', () => {
    vi.mocked(getHealth).mockReturnValue(new Promise(() => undefined));

    renderScreen();

    expect(screen.getByRole('heading', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking API availability');
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
  });

  it('announces when the API is available', async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: 'ok' });

    renderScreen();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('API available'));
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toBeInTheDocument();
  });

  it('keeps the screen and return link available when the API is unavailable', async () => {
    vi.mocked(getHealth).mockRejectedValue(new Error('Network unavailable'));

    renderScreen();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('API unavailable'));
    expect(screen.getByRole('heading', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
  });
});
