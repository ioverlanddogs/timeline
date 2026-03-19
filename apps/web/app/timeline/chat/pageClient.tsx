'use client';

import React from 'react';
import { useMemo, useState } from 'react';
import Link from 'next/link';

import CitationChips, { toUniqueCitationChips } from './CitationChips';

type Citation = {
  artifactId: string;
  excerpt: string;
  contentDateISO?: string;
  title?: string;
};

export default function TimelineChatPageClient() {
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [usedArtifactIds, setUsedArtifactIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('Please enter at least 2 characters.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/timeline/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });

      const payload = (await response.json()) as {
        answer?: string;
        citations?: Citation[];
        usedArtifactIds?: string[];
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? 'Unable to chat with timeline artifacts.');
        return;
      }

      setAnswer(payload.answer ?? '');
      setCitations(Array.isArray(payload.citations) ? payload.citations : []);
      setUsedArtifactIds(Array.isArray(payload.usedArtifactIds) ? payload.usedArtifactIds : []);
    } catch {
      setError('Unable to chat with timeline artifacts.');
    } finally {
      setLoading(false);
    }
  };

  const uniqueCitationCount = useMemo(() => toUniqueCitationChips(citations).length, [citations]);
  const groundedResponse = Boolean(answer && uniqueCitationCount > 0);
  const showNoMatches = Boolean(answer && citations.length === 0 && usedArtifactIds.length === 0);

  return (
    <section style={{ maxWidth: 900, margin: '0 auto', padding: '1.5rem' }}>
      <h1>Timeline Chat</h1>
      <p>Ask grounded questions over Drive-backed timeline summary artifacts.</p>
      <textarea
        style={{ width: '100%', minHeight: 120, padding: 10 }}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Ask a question about your timeline..."
      />
      <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
        <button onClick={() => void send()} disabled={loading}>
          {loading ? 'Sending...' : 'Send'}
        </button>
        <Link href="/timeline">Back to Timeline</Link>
      </div>

      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}
      {answer ? (
        <article style={{ marginTop: 20 }}>
          <h2>Answer</h2>
          {groundedResponse ? (
            <p
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#eff6ff',
                color: 'var(--primary-dark)',
                border: '1px solid #bfdbfe',
                borderRadius: 8,
                padding: '6px 10px',
                margin: '0 0 10px',
              }}
            >
              <span aria-hidden="true">ℹ️</span>
              Grounded in {uniqueCitationCount} timeline artifacts
            </p>
          ) : null}
          <p>{answer}</p>
          {showNoMatches ? (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: '#f9fafb',
                padding: 12,
                marginTop: 12,
              }}
            >
              <p style={{ marginTop: 0 }}>No timeline artifacts available.</p>
              <Link href="/select/drive">Connect Drive sources</Link>
            </div>
          ) : null}
          {groundedResponse ? (
            <>
              <h3 style={{ marginTop: 14, marginBottom: 4 }}>Sources</h3>
              <CitationChips citations={citations} />
            </>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
