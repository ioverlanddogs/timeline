import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn(() => ({ data: null })));

vi.mock('next/navigation', () => ({
  usePathname: pathnameMock,
}));
vi.mock('next-auth/react', () => ({
  useSession: useSessionMock,
  signOut: vi.fn(),
}));

import AppNav from './AppNav';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe('AppNav demo tabs visibility', () => {
  it('renders grouped top-level labels by default', () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_DEMO_TABS', undefined);
    pathnameMock.mockReturnValue('/timeline');

    render(<AppNav />);

    expect(screen.getByRole('link', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByText('Select')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
  });

  it('renders grouped top-level labels when feature flag is enabled', () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_DEMO_TABS', 'true');
    pathnameMock.mockReturnValue('/timeline');

    render(<AppNav />);

    expect(screen.getByRole('link', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByText('Select')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
  });
});
