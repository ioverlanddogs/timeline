import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GettingStartedPageClient from './pageClient';

const mockUseSession = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

describe('GettingStartedPageClient', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders stepper pills and active step detail', () => {
    mockUseSession.mockReturnValue({ status: 'unauthenticated', data: null });

    render(<GettingStartedPageClient isAuthConfigured />);

    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect Google' })).toBeInTheDocument();
    expect(screen.getByText('Provision')).toBeInTheDocument();
  });

  it('keeps Open chat disabled when artifacts are empty', async () => {
    mockUseSession.mockReturnValue({ status: 'authenticated', data: { driveFolderId: 'folder-1' } });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sets: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ artifacts: [] }) });

    vi.stubGlobal('fetch', fetchMock);

    render(<GettingStartedPageClient isAuthConfigured />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/timeline/artifacts/list');
    });

    expect(screen.getByRole('heading', { name: 'Select documents' })).toBeInTheDocument();
  });
});
