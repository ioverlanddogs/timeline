'use client';

import React from 'react';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';

type Citation = {
  artifactId: string;
  excerpt: string;
  contentDateISO?: string;
  title?: string;
};

type CitationChip = {
  artifactId: string;
  label: string;
  dateLabel: string | null;
  preview: string;
};

function firstMeaningfulLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? 'Untitled artifact';
}

function formatDate(dateISO?: string): string | null {
  if (!dateISO) {
    return null;
  }

  const timestamp = Date.parse(dateISO);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toLocaleDateString();
}

export function toUniqueCitationChips(citations: Citation[]): CitationChip[] {
  const byArtifact = new Map<string, Citation>();

  for (const citation of citations) {
    if (!byArtifact.has(citation.artifactId)) {
      byArtifact.set(citation.artifactId, citation);
    }
  }

  return Array.from(byArtifact.values()).map((citation) => ({
    artifactId: citation.artifactId,
    label: (citation.title?.trim() || firstMeaningfulLine(citation.excerpt)).slice(0, 80),
    dateLabel: formatDate(citation.contentDateISO),
    preview: (citation.title?.trim() || citation.excerpt || 'No preview available.').slice(0, 200),
  }));
}

export default function CitationChips({ citations }: { citations: Citation[] }) {
  const router = useRouter();
  const chips = useMemo(() => toUniqueCitationChips(citations), [citations]);

  return (
    <div aria-label="citation chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      {chips.map((chip) => (
        <button
          key={chip.artifactId}
          type="button"
          title={chip.preview}
          onClick={() => router.push(`/timeline?artifactId=${encodeURIComponent(chip.artifactId)}`)}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 999,
            background: '#f8fafc',
            padding: '8px 12px',
            cursor: 'pointer',
            maxWidth: '100%',
            textAlign: 'left',
          }}
        >
          {chip.label}
          {chip.dateLabel ? ` · ${chip.dateLabel}` : ''}
        </button>
      ))}
    </div>
  );
}
