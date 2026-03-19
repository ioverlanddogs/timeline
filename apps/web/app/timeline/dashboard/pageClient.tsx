'use client';

import React from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type QueueStatus = 'proposed' | 'accepted' | 'dismissed';
type QueueType = 'all' | 'task' | 'reminder' | 'calendar';
type QueueKind = 'all' | 'summary' | 'synthesis';

type DashboardPayload = {
  ok: true;
  summary: { totalArtifacts: number; totalSyntheses: number; proposedActions: number; openLoopsOpenCount: number; highRisksCount: number; decisionsRecentCount: number };
  topEntities: Array<{ name: string; type?: string; count: number }>;
  syntheses: Array<{ artifactId: string; title: string; mode?: string; createdAtISO?: string; contentDateISO?: string }>;
  actionQueue: Array<{
    artifactId: string;
    artifactTitle?: string;
    artifactKind?: 'summary' | 'synthesis';
    contentDateISO?: string;
    action: {
      id: string;
      type: 'reminder' | 'task' | 'calendar';
      text: string;
      dueDateISO?: string | null;
      confidence?: number | null;
      status: QueueStatus;
      updatedAtISO?: string;
      calendarEvent?: { id: string; htmlLink: string } | null;
    };
  }>;
};

export default function TimelineDashboardPageClient() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [showProposedOnly, setShowProposedOnly] = useState(true);
  const [typeFilter, setTypeFilter] = useState<QueueType>('all');
  const [kindFilter, setKindFilter] = useState<QueueKind>('all');
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [exportReport, setExportReport] = useState(true);
  const [weekResult, setWeekResult] = useState<{ synthesisText?: string; reportName?: string; reportId?: string; citations?: number; savedArtifactId?: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/timeline/dashboard');
        const payload = (await response.json()) as DashboardPayload & { error?: { message?: string } };
        if (!response.ok) {
          setError(payload.error?.message ?? 'Unable to load dashboard.');
          return;
        }
        setData(payload);
      } catch {
        setError('Unable to load dashboard.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const filteredQueue = useMemo(() => {
    const queue = data?.actionQueue ?? [];
    return queue.filter((item) => {
      if (showProposedOnly && item.action.status !== 'proposed') return false;
      if (typeFilter !== 'all' && item.action.type !== typeFilter) return false;
      if (kindFilter !== 'all' && (item.artifactKind ?? 'summary') !== kindFilter) return false;
      return true;
    });
  }, [data, kindFilter, showProposedOnly, typeFilter]);

  const updateStatusLocal = (artifactId: string, actionId: string, status: QueueStatus, calendarEvent?: { id: string; htmlLink: string }) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        actionQueue: prev.actionQueue.map((row) =>
          row.artifactId === artifactId && row.action.id === actionId
            ? {
                ...row,
                action: {
                  ...row.action,
                  status,
                  ...(calendarEvent ? { calendarEvent } : {}),
                },
              }
            : row,
        ),
      };
    });
  };

  const decide = async (artifactId: string, actionId: string, decision: 'accept' | 'dismiss') => {
    const key = `${artifactId}:${actionId}`;
    const prev = data;
    setRowErrors((state) => ({ ...state, [key]: '' }));
    setPending((state) => ({ ...state, [key]: true }));

    updateStatusLocal(artifactId, actionId, decision === 'accept' ? 'accepted' : 'dismissed');

    try {
      const response = await fetch('/api/timeline/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId, actionId, decision }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string; message?: string };
        if (payload.error === 'calendar_event_failed') {
          setRowErrors((state) => ({ ...state, [key]: 'Could not create Google Calendar event. Please try again.' }));
        } else {
          setRowErrors((state) => ({ ...state, [key]: payload.message ?? 'Unable to update action.' }));
        }
        setData(prev);
        return;
      }

      const payload = (await response.json()) as { status: QueueStatus; calendarEvent?: { id: string; htmlLink: string } };
      updateStatusLocal(artifactId, actionId, payload.status, payload.calendarEvent);
    } catch {
      setData(prev);
      setRowErrors((state) => ({ ...state, [key]: 'Unable to update action.' }));
    } finally {
      setPending((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
    }
  };

  const generateWeekInReview = async () => {
    setWeekResult(null);
    try {
      const response = await fetch('/api/timeline/week-in-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeEvidence, exportReport }),
      });
      const payload = await response.json();
      if (!response.ok) return;
      setWeekResult({
        synthesisText: payload.synthesis?.synthesis?.content,
        reportName: payload.report?.driveFileName,
        reportId: payload.report?.driveFileId,
        citations: payload.synthesis?.citations?.length,
        savedArtifactId: payload.synthesis?.savedArtifactId,
      });
    } catch {
      // noop
    }
  };

  return (
    <section style={{ maxWidth: 980, margin: '0 auto', padding: '1.5rem' }}>
      <h1>Timeline Dashboard</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Link href="/timeline/synthesize">Run synthesis</Link>
        <Link href="/ingest/url">Ingest URL</Link>
        <Link href="/timeline/chat">Timeline chat</Link>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <label><input type="checkbox" checked={includeEvidence} onChange={(event) => setIncludeEvidence(event.target.checked)} /> Include evidence</label>
        <label><input type="checkbox" checked={exportReport} onChange={(event) => setExportReport(event.target.checked)} /> Export report</label>
        <button onClick={() => void generateWeekInReview()}>Generate Week in Review</button>
      </div>
      {weekResult ? (
        <div style={{ border: '1px solid #ddd', padding: 10, marginBottom: 16 }}>
          <h3>Week in Review</h3>
          {weekResult.synthesisText ? <p>{weekResult.synthesisText}</p> : null}
          {weekResult.savedArtifactId ? <p><Link href={`/timeline?artifactId=${encodeURIComponent(weekResult.savedArtifactId)}`}>Open saved synthesis</Link></p> : null}
          {weekResult.reportId ? <p>Report saved: {weekResult.reportName ?? weekResult.reportId}</p> : null}
          <p>Citations: {weekResult.citations ?? 0}</p>
        </div>
      ) : null}

      {loading ? <p>Loading…</p> : null}
      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}

      {data ? (
        <>
          <p>
            Artifacts: {data.summary.totalArtifacts} · Syntheses: {data.summary.totalSyntheses} · Proposed actions:{' '}
            {data.summary.proposedActions}
          </p>


          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
            <div style={{ border: '1px solid #ddd', padding: 10 }}>
              <h3>Top entities</h3>
              <ul>{(data.topEntities ?? []).slice(0, 10).map((entity) => <li key={`${entity.name}-${entity.type ?? ''}`}><Link href={`/timeline?entity=${encodeURIComponent(entity.name.toLowerCase())}`}>{entity.name}</Link>{entity.type ? ` (${entity.type})` : ''} · {entity.count}</li>)}</ul>
            </div>
            <div style={{ border: '1px solid #ddd', padding: 10 }}>
              <h3>Open loops</h3>
              <p>{data.summary.openLoopsOpenCount}</p>
              <Link href="/timeline?hasOpenLoops=1">Open timeline filters</Link>
            </div>
            <div style={{ border: '1px solid #ddd', padding: 10 }}>
              <h3>High risks</h3>
              <p>{data.summary.highRisksCount}</p>
              <Link href="/timeline?hasRisks=1&riskSeverity=high">Open timeline filters</Link>
            </div>
          </div>

          <h2>Recent Syntheses</h2>
          <ul>
            {data.syntheses.map((item) => (
              <li key={item.artifactId}>
                <strong>{item.title}</strong>
                {item.mode ? ` (${item.mode})` : ''}
                {item.contentDateISO ? ` · ${new Date(item.contentDateISO).toLocaleDateString()}` : ''}{' '}
                <Link href={`/timeline?artifactId=${encodeURIComponent(item.artifactId)}`}>Open in timeline</Link>
              </li>
            ))}
          </ul>

          <h2>Action Queue</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
            <label>
              <input
                type="checkbox"
                checked={showProposedOnly}
                onChange={(event) => setShowProposedOnly(event.target.checked)}
              />{' '}
              Show only proposed
            </label>
            <label>
              Type{' '}
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as QueueType)}>
                <option value="all">All</option>
                <option value="task">Task</option>
                <option value="reminder">Reminder</option>
                <option value="calendar">Calendar</option>
              </select>
            </label>
            <label>
              Kind{' '}
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as QueueKind)}>
                <option value="all">All</option>
                <option value="summary">Summary</option>
                <option value="synthesis">Synthesis</option>
              </select>
            </label>
          </div>

          <ul>
            {filteredQueue.map((row) => {
              const rowKey = `${row.artifactId}:${row.action.id}`;
              const isPending = Boolean(pending[rowKey]);
              return (
                <li key={rowKey} style={{ marginBottom: 10 }}>
                  <strong>{row.action.text}</strong> ({row.action.type}) · <em>{row.action.status}</em>
                  {row.artifactTitle ? ` · ${row.artifactTitle}` : ''}
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button disabled={isPending || row.action.status === 'accepted'} onClick={() => void decide(row.artifactId, row.action.id, 'accept')}>
                      Accept
                    </button>
                    <button disabled={isPending || row.action.status === 'dismissed'} onClick={() => void decide(row.artifactId, row.action.id, 'dismiss')}>
                      Dismiss
                    </button>
                    {row.action.calendarEvent ? (
                      <a href={row.action.calendarEvent.htmlLink} target="_blank" rel="noreferrer">
                        Calendar event
                      </a>
                    ) : null}
                  </div>
                  {rowErrors[rowKey] ? <p style={{ color: 'var(--danger)' }}>{rowErrors[rowKey]}</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
