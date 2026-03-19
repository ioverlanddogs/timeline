import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';


import TimelineView from './TimelineView';

const makeArtifact = (overrides: Record<string, unknown> = {}) => ({
  entryKey: String(overrides.entryKey ?? `key-${overrides.artifactId ?? '1'}`),
  artifact: {
    artifactId: String(overrides.artifactId ?? 'a-1'),
    source: (overrides.source as 'gmail' | 'drive') ?? 'drive',
    sourceId: String(overrides.sourceId ?? 'src-1'),
    title: String(overrides.title ?? 'Default title'),
    createdAtISO: String(overrides.createdAtISO ?? '2026-02-14T08:00:00.000Z'),
    contentDateISO: overrides.contentDateISO as string | undefined,
    summary: String(overrides.summary ?? 'Alpha event happened. Follow-up noted.'),
    highlights: (overrides.highlights as string[]) ?? ['Alpha event happened'],
    driveFolderId: 'folder-1',
    driveFileId: String(overrides.driveFileId ?? 'file-1'),
    model: 'test-model',
    version: 1,
  },
});

afterEach(() => {
  cleanup();
});

describe('TimelineView', () => {
  it('groups artifacts by date correctly', () => {
    render(
      <TimelineView
        artifacts={[
          makeArtifact({ artifactId: '1', driveFileId: 'file-1', contentDateISO: '2026-02-14T10:00:00.000Z' }),
          makeArtifact({ artifactId: '2', driveFileId: 'file-2', contentDateISO: '2026-02-14T11:00:00.000Z' }),
          makeArtifact({ artifactId: '3', driveFileId: 'file-3', contentDateISO: '2026-02-15T10:00:00.000Z' }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: '14 Feb 2026' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '15 Feb 2026' })).toBeInTheDocument();
    expect(screen.getAllByText('View source')).toHaveLength(3);
  });

  it('places null and invalid dates under Undated', () => {
    render(
      <TimelineView
        artifacts={[
          makeArtifact({ artifactId: '1', driveFileId: 'file-1', contentDateISO: undefined }),
          makeArtifact({ artifactId: '2', driveFileId: 'file-2', contentDateISO: 'not-a-date' }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Undated' })).toBeInTheDocument();
    expect(screen.getByText('No clear date detected in source.')).toBeInTheDocument();
  });

  it('sorts date groups ascending', () => {
    render(
      <TimelineView
        artifacts={[
          makeArtifact({ artifactId: '2', driveFileId: 'file-2', contentDateISO: '2026-02-16T10:00:00.000Z' }),
          makeArtifact({ artifactId: '1', driveFileId: 'file-1', contentDateISO: '2026-02-14T10:00:00.000Z' }),
        ]}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 3 }).map((item) => item.textContent);
    expect(headings[0]).toBe('14 Feb 2026');
    expect(headings[1]).toBe('16 Feb 2026');
  });

  it('renders empty state when no artifacts', () => {
    render(<TimelineView artifacts={[]} />);

    expect(screen.getByText('No summaries yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Select from Drive' })).toHaveAttribute(
      'href',
      '/select/drive',
    );
  });

  it('renders internal source links using artifactId query param', () => {
    render(
      <TimelineView
        artifacts={[makeArtifact({ artifactId: '1', driveFileId: 'drive-abc', contentDateISO: '2026-02-14T10:00:00.000Z' })]}
      />,
    );

    expect(screen.getByRole('link', { name: 'Jump to summary' })).toHaveAttribute(
      'href',
      '/timeline?artifactId=drive-abc',
    );
  });
});
