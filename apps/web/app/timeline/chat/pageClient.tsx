'use client';

import React from 'react';
import { useMemo, useState } from 'react';
import Link from 'next/link';

import Button from '../../components/ui/Button';
import CitationChips, { toUniqueCitationChips } from './CitationChips';
import styles from './chat.module.css';

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

  const SUGGESTED_QUESTIONS = [
    'What decisions were made this month?',
    'What open loops are still unresolved?',
    'Which documents mention a deadline?',
    'Summarise the key themes across my timeline.',
  ];

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
    <section className={styles.chatPage}>
      <div className={styles.chatMain}>
        <div className={styles.messages}>
          {!answer && !loading && <p className={styles.emptyHint}>Ask a question about your timeline…</p>}

          {answer ? (
            <>
              <div className={styles.userMessage}>
                <div className={styles.userBubble}>{query}</div>
              </div>
              <div className={styles.aiMessage}>
                {groundedResponse ? (
                  <p className={styles.groundedHint}>Grounded in {uniqueCitationCount} timeline artifacts</p>
                ) : null}
                <div className={styles.aiBubble}>{answer}</div>
                {groundedResponse ? (
                  <div className={styles.citationRow}>
                    <CitationChips citations={citations} />
                  </div>
                ) : null}
                {showNoMatches ? (
                  <div className={styles.noMatchesCard}>
                    <p className={styles.noMatchesText}>No timeline artifacts available.</p>
                    <Link href="/select/drive">Connect Drive sources</Link>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {loading ? (
            <div className={styles.aiMessage}>
              <div className={styles.aiBubble}>Thinking…</div>
            </div>
          ) : null}

          {error ? <p className={styles.errorHint}>{error}</p> : null}
        </div>

        {!answer && !loading ? (
          <div className={styles.suggestedRow}>
            <p className={styles.suggestedLabel}>Try asking</p>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                className={styles.suggestedQ}
                onClick={() => {
                  const trimmed = q.trim();
                  if (trimmed.length < 2) return;
                  setQuery(q);
                  setLoading(true);
                  setError(null);
                  fetch('/api/timeline/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: trimmed }),
                  })
                    .then(async (response) => {
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
                    })
                    .catch(() => setError('Unable to chat with timeline artifacts.'))
                    .finally(() => setLoading(false));
                }}
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.inputRow}>
          <textarea
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Ask a question about your timeline…"
            rows={1}
            disabled={loading}
          />
          <Button onClick={() => void send()} disabled={loading || query.trim().length < 2}>
            {loading ? 'Thinking…' : 'Send'}
          </Button>
        </div>
      </div>

      <aside className={styles.sourcesPanel}>
        <p className={styles.panelLabel}>Sources used</p>
        {citations.length === 0 && !loading ? <p className={styles.panelEmpty}>None yet</p> : null}
        {toUniqueCitationChips(citations).map((chip) => (
          <div key={chip.artifactId} className={styles.sourceItem}>
            <span className={styles.sourceLabel}>{chip.title ?? chip.artifactId}</span>
          </div>
        ))}
      </aside>
    </section>
  );
}
