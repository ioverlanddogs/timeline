'use client';

import Link from 'next/link';
import { useState } from 'react';

type Mode = 'briefing' | 'status_report' | 'decision_log' | 'open_loops';

type Citation = {
  artifactId: string;
  excerpt: string;
  contentDateISO?: string;
  title?: string;
};

type StructuredDecision = { text: string; dateISO?: string | null; owner?: string | null; confidence?: number | null };
type StructuredOpenLoop = { text: string; owner?: string | null; dueDateISO?: string | null; status?: 'open' | 'closed'; closedAtISO?: string | null; closedReason?: string | null; sourceActionId?: string | null; confidence?: number | null };
type StructuredRisk = { text: string; severity?: 'low' | 'medium' | 'high'; likelihood?: 'low' | 'medium' | 'high'; owner?: string | null; mitigation?: string | null; confidence?: number | null };

type SynthesisResponse = {
  ok: true;
  synthesis: {
    synthesisId: string;
    mode: Mode;
    title: string;
    createdAtISO: string;
    content: string;
    keyPoints?: string[];
    entities?: Array<{ name: string; type?: string }>;
    decisions?: StructuredDecision[];
    risks?: StructuredRisk[];
    openLoops?: StructuredOpenLoop[];
  };
  citations: Citation[];
  usedArtifactIds: string[];
  savedArtifactId?: string;
};

export default function TimelineSynthesizePageClient() {
  const [mode, setMode] = useState<Mode>('briefing');
  const [title, setTitle] = useState('');
  const [dateFromISO, setDateFromISO] = useState('');
  const [dateToISO, setDateToISO] = useState('');
  const [tags, setTags] = useState('');
  const [participants, setParticipants] = useState('');
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [saveToTimeline, setSaveToTimeline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SynthesisResponse | null>(null);
  const [loopErrors, setLoopErrors] = useState<Record<string, string>>({});
  const [loopPending, setLoopPending] = useState<Record<string, boolean>>({});

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/timeline/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(dateFromISO ? { dateFromISO: new Date(dateFromISO).toISOString() } : {}),
          ...(dateToISO ? { dateToISO: new Date(dateToISO).toISOString() } : {}),
          tags: tags
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          participants: participants
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          includeEvidence,
          saveToTimeline,
        }),
      });

      const payload = (await response.json()) as SynthesisResponse & { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? 'Unable to generate synthesis.');
        return;
      }
      setResult(payload);
    } catch {
      setError('Unable to generate synthesis.');
    } finally {
      setLoading(false);
    }
  };


  const toggleOpenLoop = async (openLoopIndex: number, action: 'close' | 'reopen') => {
    if (!result?.savedArtifactId) return;
    const key = `${result.savedArtifactId}:${openLoopIndex}`;
    setLoopErrors((prev) => ({ ...prev, [key]: '' }));
    setLoopPending((prev) => ({ ...prev, [key]: true }));

    const prev = result;
    setResult({
      ...result,
      synthesis: {
        ...result.synthesis,
        openLoops: (result.synthesis.openLoops ?? []).map((loop, idx) => {
          if (idx !== openLoopIndex) return loop;
          if (action === 'close') return { ...loop, status: 'closed' as const, closedAtISO: new Date().toISOString() } as never;
          return { ...loop, status: 'open' as const, closedAtISO: null, closedReason: null } as never;
        }),
      },
    });

    try {
      const response = await fetch('/api/timeline/open-loops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId: result.savedArtifactId, openLoopIndex, action }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setResult(prev);
        setLoopErrors((state) => ({ ...state, [key]: payload.error?.message ?? 'Unable to update open loop.' }));
        return;
      }

      const payload = (await response.json()) as { updatedOpenLoops?: StructuredOpenLoop[] };
      if (payload.updatedOpenLoops) {
        setResult((current) =>
          current
            ? {
                ...current,
                synthesis: { ...current.synthesis, openLoops: payload.updatedOpenLoops },
              }
            : current,
        );
      }
    } catch {
      setResult(prev);
      setLoopErrors((state) => ({ ...state, [key]: 'Unable to update open loop.' }));
    } finally {
      setLoopPending((prevState) => {
        const next = { ...prevState };
        delete next[key];
        return next;
      });
    }
  };

  const noArtifacts = Boolean(result && result.usedArtifactIds.length === 0);

  return (
    <section style={{ maxWidth: 920, margin: '0 auto', padding: '1.5rem' }}>
      <h1>Timeline Synthesis</h1>
      <p>Generate a cross-artifact briefing with citations grounded in your timeline artifacts.</p>

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <label>
          Mode
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="briefing">Briefing</option>
            <option value="status_report">Status report</option>
            <option value="decision_log">Decision log</option>
            <option value="open_loops">Open loops</option>
          </select>
        </label>

        <label>
          Title (optional)
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly timeline briefing" />
        </label>

        <label>
          Date from
          <input type="date" value={dateFromISO} onChange={(event) => setDateFromISO(event.target.value)} />
        </label>

        <label>
          Date to
          <input type="date" value={dateToISO} onChange={(event) => setDateToISO(event.target.value)} />
        </label>

        <label>
          Tags (comma-separated)
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="finance, legal" />
        </label>

        <label>
          Participants (comma-separated)
          <input value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="alice@example.com, bob@example.com" />
        </label>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 16 }}>
        <label>
          <input type="checkbox" checked={includeEvidence} onChange={(event) => setIncludeEvidence(event.target.checked)} /> Include evidence
        </label>
        <label>
          <input type="checkbox" checked={saveToTimeline} onChange={(event) => setSaveToTimeline(event.target.checked)} /> Save to timeline
        </label>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
        <button disabled={loading} onClick={() => void generate()}>
          {loading ? 'Generating...' : 'Generate synthesis'}
        </button>
        <Link href="/timeline">Back to timeline</Link>
      </div>

      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}

      {result ? (
        <article style={{ marginTop: 20 }}>
          <h2>{result.synthesis.title}</h2>
          <p>{result.synthesis.content}</p>
          <p>Used artifacts: {result.usedArtifactIds.length}</p>
          {noArtifacts ? <p style={{ color: '#666' }}>No matching artifacts were found.</p> : null}

          {result.synthesis.keyPoints?.length ? (
            <>
              <h3>Key points</h3>
              <ul>{result.synthesis.keyPoints.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : null}
          {result.synthesis.entities?.length ? (
            <>
              <h3>Entities</h3>
              <ul>{result.synthesis.entities.map((item, idx) => <li key={`entity-${idx}`}>{item.name}{item.type ? ` (${item.type})` : ''}</li>)}</ul>
            </>
          ) : null}
          {result.synthesis.decisions?.length ? (
            <>
              <h3>Decisions</h3>
              <ul>{result.synthesis.decisions.map((item, idx) => <li key={`dec-${idx}`}>{item.text}</li>)}</ul>
            </>
          ) : null}
          {result.synthesis.risks?.length ? (
            <>
              <h3>Risks</h3>
              <ul>{result.synthesis.risks.map((item, idx) => <li key={`risk-${idx}`}>{item.text}</li>)}</ul>
            </>
          ) : null}
          {result.synthesis.openLoops?.length ? (
            <>
              <h3>Open loops</h3>
              <ul>
                {result.synthesis.openLoops.map((item, idx) => {
                  const key = `${result.savedArtifactId ?? 'unsaved'}:${idx}`;
                  const isClosed = (item.status ?? 'open') === 'closed';
                  return (
                    <li key={`loop-${idx}`}>
                      {item.text} <em>({isClosed ? 'closed' : 'open'})</em>{' '}
                      {result.savedArtifactId ? (
                        <button disabled={Boolean(loopPending[key])} onClick={() => void toggleOpenLoop(idx, isClosed ? 'reopen' : 'close')}>
                          {isClosed ? 'Reopen' : 'Mark closed'}
                        </button>
                      ) : null}
                      {loopErrors[key] ? <span style={{ color: 'var(--danger)' }}> {loopErrors[key]}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          <h3>Citations</h3>
          <ul>
            {result.citations.map((citation) => (
              <li key={`${citation.artifactId}-${citation.excerpt}`} style={{ marginBottom: 10 }}>
                <strong>{citation.title ?? citation.artifactId}</strong>
                {citation.contentDateISO ? ` (${new Date(citation.contentDateISO).toLocaleDateString()})` : ''}
                <div>{citation.excerpt}</div>
                <Link href={`/timeline?artifactId=${encodeURIComponent(citation.artifactId)}`}>Open artifact in timeline</Link>
              </li>
            ))}
          </ul>

          {result.savedArtifactId ? (
            <p>
              <Link href={`/timeline?artifactId=${encodeURIComponent(result.savedArtifactId)}`}>
                Open saved synthesis in timeline
              </Link>
            </p>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
