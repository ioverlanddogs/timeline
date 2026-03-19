import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectPageClient from './pageClient';

const signInMock = vi.fn();
const signOutMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

const baseProps = {
  initial: {
    isConfigured: true,
    signedIn: false,
    email: null,
    scopes: [],
    driveFolderId: null,
  },
  scopeStatus: {
    configured: ['https://www.googleapis.com/auth/gmail.readonly'],
    missing: [],
    isComplete: true,
  },
};

describe('ConnectPageClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/health') {
        return new Response(JSON.stringify({ ok: true, ts: '2024-01-01T00:00:00.000Z' }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the three section headers', async () => {
    render(<ConnectPageClient {...baseProps} />);

    expect(screen.getByText('1) Account & Auth')).toBeInTheDocument();
    expect(screen.getByText('2) Drive Folder Provisioning')).toBeInTheDocument();
    expect(screen.getByText('3) Diagnostics')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
    });
  });

  it('shows sign in required copy when signed out', () => {
    render(<ConnectPageClient {...baseProps} />);

    expect(screen.getByText(/sign in required/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconnect google/i })).toBeInTheDocument();
  });

  it('shows 401 message when provisioning fails due to auth', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/health') {
        return new Response(JSON.stringify({ ok: true, ts: '2024-01-01T00:00:00.000Z' }), {
          status: 200,
        });
      }
      if (url === '/api/google/drive/provision' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: { message: 'Reconnect required.' } }), {
          status: 401,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    render(
      <ConnectPageClient
        {...baseProps}
        initial={{ ...baseProps.initial, signedIn: true, scopes: ['https://www.googleapis.com/auth/drive.file'] }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /provision drive folder/i }));

    await waitFor(() => {
      expect(screen.getByText("You're not signed in.")).toBeInTheDocument();
    });
  });
});
