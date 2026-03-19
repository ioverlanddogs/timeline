import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TimelinePageClient from './pageClient';

const mockUseSession = vi.fn();
const pushMock = vi.fn();
const replaceMock = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}));

const mockFetch = (handler: (url: string, init?: RequestInit) => Response) => {
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return handler(url, init);
  });
};

const withIndexGet =
  (handler: (url: string, init?: RequestInit) => Response) =>
  (url: string, init?: RequestInit) => {
    if (url === '/api/timeline/index/get') {
      return new Response(JSON.stringify({ index: null }), { status: 200 });
    }
    if (url === '/api/timeline/exports/history?limit=10') {
      return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
    }
    return handler(url, init);
  };

const buildApiError = (status: number, code: string, message: string) =>
  new Response(
    JSON.stringify({
      error: { code, message },
      error_code: code,
    }),
    { status },
  );

const setSelections = () => {
  window.localStorage.setItem(
    'timeline.gmailSelections',
    JSON.stringify([
      {
        id: 'msg-1',
        threadId: 'thread-1',
        subject: 'Hello',
        from: 'alice@example.com',
        date: '2024-01-01T00:00:00Z',
        snippet: 'Snippet',
      },
    ]),
  );
};

const syncArtifact = {
  artifactId: 'gmail:msg-1',
  source: 'gmail',
  sourceId: 'msg-1',
  title: 'Hello',
  createdAtISO: '2024-01-02T00:00:00Z',
  summary: 'Synced summary',
  highlights: ['First highlight'],
  driveFolderId: 'folder-1',
  driveFileId: 'file-1',
  driveWebViewLink: 'https://drive.google.com/file',
  model: 'stub',
  version: 1,
};

const artifactWithMetadata = {
  ...syncArtifact,
  sourceMetadata: {
    from: 'alice@example.com',
    subject: 'Hello',
    threadId: 'thread-1',
    labels: ['INBOX'],
  },
  sourcePreview: 'Preview text from the message body.',
};

const syncArtifactWithUpdatedAtA = {
  ...syncArtifact,
  driveFileId: 'file-a',
  updatedAtISO: '2024-02-05T12:00:00.000Z',
};

const syncArtifactWithUpdatedAtB = {
  ...syncArtifact,
  sourceId: 'msg-2',
  driveFileId: 'file-b',
  updatedAtISO: '2024-02-06T15:30:00.000Z',
};

const selectionList = [
  {
    driveFileId: 'selection-1',
    name: 'Sprint 1',
    updatedAtISO: '2024-02-01T00:00:00Z',
  },
  {
    driveFileId: 'selection-2',
    name: 'Sprint 2',
    updatedAtISO: '2024-02-02T00:00:00Z',
    driveWebViewLink: 'https://drive.google.com/selection',
  },
];

const selectionSet = {
  id: 'set-1',
  name: 'Sprint 1',
  createdAtISO: '2024-02-01T00:00:00Z',
  updatedAtISO: '2024-02-02T00:00:00Z',
  items: [
    { source: 'gmail', id: 'msg-1', title: 'Hello', dateISO: '2024-01-01T00:00:00Z' },
    { source: 'drive', id: 'file-1', title: 'Spec', dateISO: '2024-01-03T00:00:00Z' },
  ],
  notes: 'Notes',
  version: 1,
  driveFolderId: 'folder-1',
  driveFileId: 'selection-1',
  driveWebViewLink: 'https://drive.google.com/selection-1',
};

const indexPayload = {
  version: 1,
  updatedAtISO: '2024-03-01T12:00:00Z',
  driveFolderId: 'folder-1',
  indexFileId: 'index-1',
  summaries: [
    {
      driveFileId: 'summary-1',
      title: 'Q1 Plan',
      source: 'drive',
      sourceId: 'summary-1',
      updatedAtISO: '2024-03-01T11:00:00Z',
    },
  ],
  selectionSets: [
    {
      driveFileId: 'selection-1',
      name: 'Sprint 1',
      updatedAtISO: '2024-03-01T10:00:00Z',
    },
  ],
  stats: { totalSummaries: 1, totalSelectionSets: 1 },
};

describe('TimelinePageClient', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    pushMock.mockClear();
    replaceMock.mockClear();
    mockSearchParams = new URLSearchParams();
    mockUseSession.mockReturnValue({
      data: { driveFolderId: 'folder-1' },
      status: 'authenticated',
    });
  });

  afterEach(() => {
    cleanup();
  });


  it('auto-clears stale selection storage and shows migration warning', async () => {
    window.localStorage.setItem('timeline.selectionVersion', '1');
    window.localStorage.setItem('timeline.gmailSelections', JSON.stringify([{ foo: 'bar' }]));
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByText(/saved selection format changed/i)).toBeInTheDocument();
    });
    expect(window.localStorage.getItem('timeline.gmailSelections')).toBeNull();
    expect(window.localStorage.getItem('timeline.selectionVersion')).toBe('2');
  });

  it('shows invalid_request with clear selections action', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return buildApiError(400, 'invalid_request', 'Invalid request payload.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid_request/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /clear selections/i }));
    expect(window.localStorage.getItem('timeline.gmailSelections')).toBeNull();
  });

  it('shows an empty state when no selections exist', () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    expect(screen.getByText(/no items selected yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate summaries/i })).toBeDisabled();
  });

  it('renders the index panel with status details', async () => {
    mockFetch((url) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: indexPayload }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByText('Index')).toBeInTheDocument();
      expect(screen.getByText('Present')).toBeInTheDocument();
      expect(screen.getAllByText('Summaries').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Saved Selections').length).toBeGreaterThan(0);
    });
  });

  it('refreshes the index and shows a success banner', async () => {
    mockFetch((url, init) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/index/rebuild' && init?.method === 'POST') {
        return new Response(JSON.stringify({ index: indexPayload }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    fireEvent.click(screen.getByRole('button', { name: /refresh index/i }));

    await waitFor(() => {
      expect(screen.getByText(/index refreshed/i)).toBeInTheDocument();
    });
  });

  it('shows rate limited and upstream error notices for index refresh', async () => {
    mockFetch((url, init) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/index/rebuild' && init?.method === 'POST') {
        return buildApiError(429, 'rate_limited', 'Too many requests. Try again in a moment.');
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    fireEvent.click(screen.getByRole('button', { name: /refresh index/i }));

    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
  });

  it('shows an upstream error notice for index refresh failures', async () => {
    mockFetch((url, init) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/index/rebuild' && init?.method === 'POST') {
        return buildApiError(502, 'upstream_error', 'Google API error.');
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    fireEvent.click(screen.getByRole('button', { name: /refresh index/i }));

    await waitFor(() => {
      expect(screen.getByText(/google returned an error/i)).toBeInTheDocument();
    });
  });

  it('shows reconnect CTA when summarize returns 401', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return buildApiError(401, 'reconnect_required', 'Reconnect required.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText(/reconnect required/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /connect your google account/i })).toBeInTheDocument();
    });
  });

  it('shows provision CTA when summarize returns drive_not_provisioned', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return buildApiError(400, 'drive_not_provisioned', 'Drive folder not provisioned.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText(/provision a drive folder/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /\/connect/i })).toBeInTheDocument();
    });
  });

  it('shows a rate limit notice when summarize is rate limited', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return buildApiError(429, 'rate_limited', 'Too many requests. Try again in a moment.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
  });

  it('navigates to the new summary after summarize succeeds', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return new Response(JSON.stringify({ artifacts: [syncArtifact], failed: [] }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    }));

    const scrollSpy = vi.fn();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    Element.prototype.scrollIntoView = scrollSpy;

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(`/timeline?artifactId=${syncArtifact.driveFileId}`);
      expect(scrollSpy).toHaveBeenCalled();
    });
  });

  it('syncs artifacts from Drive when clicking sync button', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return new Response(JSON.stringify({ artifacts: [syncArtifact], files: [] }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/synced 1 artifacts from drive/i)).toBeInTheDocument();
      expect(screen.getByText(/synced summary/i)).toBeInTheDocument();
    });
  });

  it('syncs artifacts since the last sync when available', async () => {
    setSelections();
    const lastSyncISO = '2024-02-10T00:00:00.000Z';
    window.localStorage.setItem('timeline.lastSyncISO', lastSyncISO);

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (
        url ===
        `/api/timeline/artifacts/list?since=${encodeURIComponent(lastSyncISO)}`
      ) {
        return new Response(JSON.stringify({ artifacts: [syncArtifact], files: [] }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/timeline/artifacts/list?since=${encodeURIComponent(lastSyncISO)}`,
      );
      expect(screen.getByText(/since last sync/i)).toBeInTheDocument();
    });
  });

  it('does not advance last sync cursor when sync returns zero artifacts', async () => {
    setSelections();
    const lastSyncISO = '2024-02-10T00:00:00.000Z';
    window.localStorage.setItem('timeline.lastSyncISO', lastSyncISO);
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({ [syncArtifact.artifactId]: syncArtifact }));

    mockFetch((url) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === `/api/timeline/artifacts/list?since=${encodeURIComponent(lastSyncISO)}`) {
        return new Response(JSON.stringify({ artifacts: [], files: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/no new artifacts found/i)).toBeInTheDocument();
    });
    expect(window.localStorage.getItem('timeline.lastSyncISO')).toBe(lastSyncISO);
  });

  it('advances last sync cursor to max updatedAtISO across synced artifacts', async () => {
    setSelections();

    mockFetch((url) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return new Response(
          JSON.stringify({
            artifacts: [syncArtifactWithUpdatedAtA, syncArtifactWithUpdatedAtB],
            files: [],
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/synced 2 artifacts from drive/i)).toBeInTheDocument();
    });

    expect(window.localStorage.getItem('timeline.lastSyncISO')).toBe(
      '2024-02-06T15:30:00.000Z',
    );
  });

  it('runs a full sync without a since cursor after resetting sync state', async () => {
    setSelections();
    const lastSyncISO = '2024-02-10T00:00:00.000Z';
    window.localStorage.setItem('timeline.lastSyncISO', lastSyncISO);

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return new Response(JSON.stringify({ artifacts: [syncArtifact], files: [] }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /full sync/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /full sync/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/timeline/artifacts/list');
      expect(screen.getByText(/synced 1 artifacts from drive/i)).toBeInTheDocument();
    });

    expect(fetchSpy).not.toHaveBeenCalledWith(
      `/api/timeline/artifacts/list?since=${encodeURIComponent(lastSyncISO)}`,
    );
    expect(window.localStorage.getItem('timeline.lastSyncISO')).toBe('2024-01-02T00:00:00.000Z');
  });

  it('shows no summaries guidance when local and remote artifacts are both empty', async () => {
    mockFetch((url) => {
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return new Response(JSON.stringify({ artifacts: [], files: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(
        screen.getByText(
          /no summaries found in drive\. create a summary from gmail\/drive selection, then sync\./i,
        ),
      ).toBeInTheDocument();
    });
  });

  it('renders search results from Drive-scoped search', async () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/search')) {
        return new Response(
          JSON.stringify({
            q: 'roadmap',
            type: 'all',
            results: [
              {
                kind: 'selection',
                driveFileId: 'selection-1',
                driveWebViewLink: 'https://drive.google.com/selection',
                title: 'Roadmap set',
                updatedAtISO: '2024-02-02T00:00:00Z',
                snippet: 'Mentions the roadmap',
                matchFields: ['name'],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.change(screen.getByPlaceholderText(/search summaries or saved selections/i), {
      target: { value: 'roadmap' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/roadmap set/i)).toBeInTheDocument();
      expect(screen.getAllByText(/saved selection/i).length).toBeGreaterThan(0);
      expect(screen.getByRole('link', { name: /open in drive/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /load set/i })).toBeInTheDocument();
    });
  });

  it('shows an inline hint when the search query is too short', async () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.change(screen.getByPlaceholderText(/search summaries or saved selections/i), {
      target: { value: 'a' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/enter at least 2 characters/i)).toBeInTheDocument();
    });
  });

  it('shows reconnect CTA when search returns 401', async () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/search')) {
        return buildApiError(401, 'reconnect_required', 'Reconnect required.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.change(screen.getByPlaceholderText(/search summaries or saved selections/i), {
      target: { value: 'plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/search needs a reconnect/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /connect your google account/i })).toBeInTheDocument();
    });
  });

  it('shows an upstream timeout notice when search fails', async () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/search')) {
        return buildApiError(504, 'upstream_timeout', 'Google request timed out. Please retry.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.change(screen.getByPlaceholderText(/search summaries or saved selections/i), {
      target: { value: 'plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/google returned an error/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry search/i })).toBeInTheDocument();
    });
  });

  it('shows reconnect CTA when sync returns 401', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return buildApiError(401, 'reconnect_required', 'Reconnect required.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/drive sync needs a reconnect/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /connect your google account/i })).toBeInTheDocument();
    });
  });

  it('shows provision CTA when sync returns drive_not_provisioned', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return buildApiError(400, 'drive_not_provisioned', 'Drive folder not provisioned.');
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sync from drive/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /sync from drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/provision a drive folder to sync summaries/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /\/connect/i })).toBeInTheDocument();
    });
  });

  it('auto-syncs on open when enabled', async () => {
    setSelections();
    window.localStorage.setItem('timeline.autoSyncOnOpen', 'true');
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/timeline/index/get') {
        return new Response(JSON.stringify({ index: null }), { status: 200 });
      }
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/artifacts/list') {
        return new Response(JSON.stringify({ artifacts: [syncArtifact], files: [] }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/timeline/artifacts/list');
      expect(screen.getByText(/synced 1 artifacts from drive/i)).toBeInTheDocument();
    });
  });

  it('saves a selection and shows a success banner', async () => {
    setSelections();
    mockFetch(withIndexGet((url, init) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/selection/save' && init?.method === 'POST') {
        return new Response(JSON.stringify({ set: selectionSet }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.click(screen.getByRole('button', { name: /save selection/i }));
    fireEvent.change(screen.getByPlaceholderText(/q2 launch research/i), {
      target: { value: 'Sprint 1' },
    });
    fireEvent.change(screen.getByPlaceholderText(/why this selection matters/i), {
      target: { value: 'Core selection' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save to drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved set/i)).toBeInTheDocument();
    });
  });

  it('lists saved sets and loads a preview', async () => {
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: selectionList }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/selection/read')) {
        return new Response(JSON.stringify({ set: selectionSet }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByText('Sprint 1')).toBeInTheDocument();
      expect(screen.getByText('Sprint 2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Load$/ })[0]);

    await waitFor(() => {
      expect(screen.getByText(/2 items/i)).toBeInTheDocument();
      expect(screen.getByText(/loaded set/i)).toBeInTheDocument();
    });
  });

  it('merges a loaded selection into local storage', async () => {
    setSelections();
    window.localStorage.setItem(
      'timeline.driveSelections',
      JSON.stringify([
        { id: 'file-2', name: 'Existing', mimeType: 'text/plain', modifiedTime: '2024-01-02' },
      ]),
    );

    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: selectionList }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/selection/read')) {
        return new Response(JSON.stringify({ set: selectionSet }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByText('Sprint 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /merge into selection/i })[0]);

    await waitFor(() => {
      const gmailStored = JSON.parse(window.localStorage.getItem('timeline.gmailSelections') || '[]');
      const driveStored = JSON.parse(window.localStorage.getItem('timeline.driveSelections') || '[]');
      expect(gmailStored).toHaveLength(1);
      expect(driveStored).toHaveLength(2);
    });
  });

  it('renders source metadata and toggles the content preview', async () => {
    setSelections();
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({ 'gmail:msg-1': artifactWithMetadata }));
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByText('From', { selector: 'span' })).toBeInTheDocument();
      expect(screen.getByText('Subject', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);

    const previewSummary = screen.getByText(/content preview/i);
    const previewDetails = previewSummary.closest('details');
    expect(previewDetails).not.toHaveAttribute('open');

    fireEvent.click(previewSummary);
    expect(previewDetails).toHaveAttribute('open');
    expect(screen.getByText(/preview text from the message body/i)).toBeInTheDocument();
  });

  it('renders grouping controls and switches to weekly view', async () => {
    setSelections();
    window.localStorage.setItem(
      'timeline.driveSelections',
      JSON.stringify([
        { id: 'file-1', name: 'Spec', mimeType: 'text/plain', modifiedTime: '2024-01-08T00:00:00Z' },
      ]),
    );
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /day/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /week/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /month/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /week/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/week of/i).length).toBeGreaterThan(0);
    });
  });

  it('filters entries and clears filters', async () => {
    setSelections();
    window.localStorage.setItem(
      'timeline.driveSelections',
      JSON.stringify([
        { id: 'file-1', name: 'Spec', mimeType: 'text/plain', modifiedTime: '2024-01-03T00:00:00Z' },
      ]),
    );
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Spec' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Source'), {
      target: { value: 'gmail' },
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Spec' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /clear all filters/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Spec' })).toBeInTheDocument();
    });
  });


  it('renders timeline entries from stored artifacts when local selections are empty', async () => {
    window.localStorage.setItem(
      'timeline.summaryArtifacts',
      JSON.stringify({ 'gmail:msg-1': syncArtifact }),
    );
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
      expect(screen.getByText('1 selected, 1 summarized, 0 pending')).toBeInTheDocument();
    });
  });

  it('does not duplicate entries when both selections and artifacts exist for the same item', async () => {
    setSelections();
    window.localStorage.setItem(
      'timeline.summaryArtifacts',
      JSON.stringify({ 'gmail:msg-1': syncArtifact }),
    );
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getAllByRole('heading', { name: 'Hello' })).toHaveLength(1);
      expect(screen.getByText('1 selected, 1 summarized, 0 pending')).toBeInTheDocument();
    });
  });

  it('keeps summarized Drive-derived entries visible with status all filter', async () => {
    window.localStorage.setItem(
      'timeline.summaryArtifacts',
      JSON.stringify({ 'gmail:msg-1': syncArtifact }),
    );
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'all' },
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    });
  });

  it('jumps to a timeline entry from search results', async () => {
    setSelections();
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url.startsWith('/api/timeline/search')) {
        return new Response(
          JSON.stringify({
            q: 'hello',
            type: 'summary',
            results: [
              {
                kind: 'summary',
                driveFileId: 'summary-1',
                title: 'Hello',
                updatedAtISO: '2024-01-02T00:00:00Z',
                snippet: 'Matched',
                matchFields: ['title'],
                source: 'gmail',
                sourceId: 'msg-1',
                createdAtISO: '2024-01-02T00:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }));

    const scrollSpy = vi.fn();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    Element.prototype.scrollIntoView = scrollSpy;

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/search summaries or saved selections/i), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /jump to item/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /jump to item/i }));

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
  });

  it('renders suggested actions and accepts an action', async () => {
    setSelections();
    const artifactWithActions = {
      ...artifactWithMetadata,
      suggestedActions: [
        { id: 'act-1', type: 'task', text: 'Prepare notes', status: 'proposed' },
      ],
    };

    mockFetch(withIndexGet((url, init) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return new Response(JSON.stringify({ artifacts: [artifactWithActions], failed: [] }), { status: 200 });
      }
      if (url === '/api/timeline/actions' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, artifactId: 'file-1', actionId: 'act-1', status: 'accepted' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText('Actions')).toBeInTheDocument();
      expect(screen.getByText(/prepare notes/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Accept$/i }));

    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
      expect(calls.some((call) => call[0] === '/api/timeline/actions')).toBe(true);
    });
  });

  it('renders calendar event link after accepting calendar action and shows inline error on failure', async () => {
    setSelections();
    const artifactWithCalendarAction = {
      ...artifactWithMetadata,
      suggestedActions: [
        { id: 'act-calendar', type: 'calendar', text: 'Schedule planning', status: 'proposed', dueDateISO: '2024-02-10T09:00:00Z' },
      ],
    };

    let attempt = 0;
    mockFetch(withIndexGet((url, init) => {
      if (url === '/api/timeline/exports/history?limit=10') {
        return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/summarize') {
        return new Response(JSON.stringify({ artifacts: [artifactWithCalendarAction], failed: [] }), { status: 200 });
      }
      if (url === '/api/timeline/actions' && init?.method === 'POST') {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: 'calendar_event_failed' }), { status: 502 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            artifactId: 'file-1',
            actionId: 'act-calendar',
            status: 'accepted',
            calendarEvent: {
              id: 'evt-1',
              htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
              startISO: '2024-02-10T09:00:00Z',
              endISO: '2024-02-10T10:00:00Z',
              createdAtISO: '2024-02-01T00:00:00Z',
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate summaries/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /generate summaries/i }));

    await waitFor(() => {
      expect(screen.getByText(/schedule planning/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Accept$/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not create google calendar event/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Accept$/i }));

    await waitFor(() => {
      expect(screen.getByText('Accepted / dismissed')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Accepted / dismissed'));

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /view event/i })).toHaveAttribute(
        'href',
        'https://calendar.google.com/calendar/event?eid=abc',
      );
    });
  });


  it('renders open loops and closes via API', async () => {
    setSelections();
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({
      'gmail:msg-1': {
        ...syncArtifact,
        openLoops: [{ text: 'Follow up with legal', status: 'open' }],
      },
    }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/timeline/index/get') return new Response(JSON.stringify({ index: null }), { status: 200 });
      if (url === '/api/timeline/selection/list') return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      if (url === '/api/timeline/open-loops' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, updatedOpenLoops: [{ text: 'Follow up with legal', status: 'closed', closedAtISO: '2026-01-01T00:00:00Z' }] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<TimelinePageClient />);

    fireEvent.click(await screen.findByText('Structured'));
    fireEvent.click(await screen.findByRole('button', { name: /mark closed/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/timeline/open-loops', expect.any(Object));
    });
  });


  it('applies entity filter to visible artifacts and exports filtered artifactIds', async () => {
    window.localStorage.setItem(
      'timeline.summaryArtifacts',
      JSON.stringify({
        'gmail:msg-1': {
          artifactId: 'gmail:msg-1',
          source: 'gmail',
          sourceId: 'msg-1',
          title: 'Acme kickoff',
          createdAtISO: '2024-01-02T00:00:00Z',
          summary: 'Discussed Acme launch',
          highlights: ['Acme timeline'],
          entities: [{ name: 'Acme Corp', type: 'org' }],
          driveFolderId: 'folder-1',
          driveFileId: 'file-1',
          model: 'stub',
          version: 1,
        },
        'gmail:msg-2': {
          artifactId: 'gmail:msg-2',
          source: 'gmail',
          sourceId: 'msg-2',
          title: 'Bob follow-up',
          createdAtISO: '2024-01-03T00:00:00Z',
          summary: 'General follow-up',
          highlights: ['No org mention'],
          entities: [{ name: 'Bob Stone', type: 'person' }],
          driveFolderId: 'folder-1',
          driveFileId: 'file-2',
          model: 'stub',
          version: 1,
        },
      }),
    );

    mockFetch(withIndexGet((url, init) => {
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      if (url === '/api/timeline/export/pdf') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { artifactIds?: string[] };
        expect(body.artifactIds).toEqual(['file-1']);
        return new Response(new Blob(['pdf']), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getAllByText(/2 shown of 2 total/i).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: /acme corp/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/1 shown of 2 total/i).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => {
      expect(screen.getByText(/pdf exported successfully/i)).toBeInTheDocument();
    });
  });

  it('opens artifact details drawer on summaries row click', async () => {
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({ 'gmail:msg-1': syncArtifact }));
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    fireEvent.click(await screen.findByText(/synced summary/i));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /artifact details/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/note/i)).toBeInTheDocument();
  });

  it('opens drawer from deep link artifactId on first render', async () => {
    mockSearchParams = new URLSearchParams('artifactId=file-1');
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({ 'gmail:msg-1': syncArtifact }));
    mockFetch(withIndexGet((url) => {
      if (url === '/api/timeline/selection/list') {
        return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }));

    render(<TimelinePageClient />);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /artifact details/i })).toBeInTheDocument();
    });
  });

  it('saves annotation and updates local entity index immediately', async () => {
    window.localStorage.setItem('timeline.summaryArtifacts', JSON.stringify({ 'gmail:msg-1': syncArtifact }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/timeline/index/get') return new Response(JSON.stringify({ index: null }), { status: 200 });
      if (url === '/api/timeline/selection/list') return new Response(JSON.stringify({ sets: [] }), { status: 200 });
      if (url === '/api/timeline/exports/history?limit=10') return new Response(JSON.stringify({ items: [], updatedAtISO: '2024-01-01T00:00:00.000Z' }), { status: 200 });
      if (url === '/api/timeline/quality/apply-annotation' && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { patch?: { note?: string; entities?: string[] } };
        expect(body.patch?.note).toBe('Needs follow-up');
        expect(body.patch?.entities).toEqual(['Acme']);
        return new Response(JSON.stringify({ ok: true, artifactId: 'file-1', userAnnotations: { entities: ['Acme'], note: 'Needs follow-up', updatedAtISO: '2024-01-03T00:00:00.000Z' } }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<TimelinePageClient />);

    fireEvent.click(await screen.findByText(/synced summary/i));
    fireEvent.change(screen.getByLabelText(/entities \(comma-separated\)/i), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Needs follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /acme/i })).toBeInTheDocument();
    });
  });


});
