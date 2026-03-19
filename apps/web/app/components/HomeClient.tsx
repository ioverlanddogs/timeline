'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import Button from './ui/Button';
import Skeleton from './ui/Skeleton';
import { parseApiError } from '../lib/apiErrors';
import { fetchWithTimeout } from '../lib/fetchWithTimeout';
import type { CalendarEntry, SummaryArtifact } from '../lib/types';
import { isCalendarEntry, normalizeCalendarEntry } from '../lib/validateCalendarEntry';
import { isSummaryArtifact, normalizeArtifact } from '../lib/validateArtifact';
import styles from '../page.module.css';

type MetricStatus = 'loading' | 'ready' | 'needs-connect' | 'error';

type CalendarResponse = {
  entries?: CalendarEntry[];
};

type TimelineArtifactsResponse = {
  artifacts?: SummaryArtifact[];
};

type MetricState = {
  count: number;
  status: MetricStatus;
  message?: string;
};

const LAST_SYNC_KEY = 'timeline.lastSyncISO';

const syncFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const formatSyncLabel = (value: string | null) => {
  if (!value) {
    return 'Not yet synced';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return 'Not yet synced';
  }
  return syncFormatter.format(parsed);
};

export default function HomeClient() {
  const [calendarMetric, setCalendarMetric] = useState<MetricState>({
    count: 0,
    status: 'loading',
  });
  const [timelineMetric, setTimelineMetric] = useState<MetricState>({
    count: 0,
    status: 'loading',
  });
  const [recentArtifacts, setRecentArtifacts] = useState<SummaryArtifact[]>([]);
  const [openLoopCount, setOpenLoopCount] = useState(0);
  const [lastSyncISO, setLastSyncISO] = useState<string | null>(null);
  const showConnectCta =
    calendarMetric.status === 'needs-connect' || timelineMetric.status === 'needs-connect';

  const lastSyncLabel = useMemo(() => formatSyncLabel(lastSyncISO), [lastSyncISO]);

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    setCalendarMetric((prev) => ({ ...prev, status: 'loading', message: undefined }));
    setTimelineMetric((prev) => ({ ...prev, status: 'loading', message: undefined }));

    try {
      const [calendarResponse, timelineResponse] = await Promise.all([
        fetchWithTimeout('/api/calendar/entries', { signal }),
        fetchWithTimeout('/api/timeline/artifacts/list', { signal }),
      ]);

      if (calendarResponse.ok) {
        const calendarData = (await calendarResponse.json()) as CalendarResponse;
        const entries = Array.isArray(calendarData.entries)
          ? calendarData.entries.filter(isCalendarEntry).map(normalizeCalendarEntry)
          : [];
        setCalendarMetric({ count: entries.length, status: 'ready' });
      } else if (calendarResponse.status === 401 || calendarResponse.status === 503) {
        setCalendarMetric({ count: 0, status: 'needs-connect' });
      } else {
        const apiError = await parseApiError(calendarResponse);
        setCalendarMetric({
          count: 0,
          status: 'error',
          message: apiError?.message ?? 'Unable to load calendar entries.',
        });
      }

      if (timelineResponse.ok) {
        const timelineData = (await timelineResponse.json()) as TimelineArtifactsResponse;
        const artifacts = Array.isArray(timelineData.artifacts)
          ? timelineData.artifacts.filter(isSummaryArtifact).map(normalizeArtifact)
          : [];
        setTimelineMetric({ count: artifacts.length, status: 'ready' });
        const sorted = [...artifacts].sort((a, b) =>
          (b.createdAtISO ?? '').localeCompare(a.createdAtISO ?? ''),
        );
        setRecentArtifacts(sorted.slice(0, 3));
        setOpenLoopCount(artifacts.filter((a) => (a.openLoops?.length ?? 0) > 0).length);
      } else if (timelineResponse.status === 401 || timelineResponse.status === 503) {
        setTimelineMetric({ count: 0, status: 'needs-connect' });
        setRecentArtifacts([]);
        setOpenLoopCount(0);
      } else {
        const apiError = await parseApiError(timelineResponse);
        setTimelineMetric({
          count: 0,
          status: 'error',
          message: apiError?.message ?? 'Unable to load timeline summaries.',
        });
        setRecentArtifacts([]);
        setOpenLoopCount(0);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setCalendarMetric({
        count: 0,
        status: 'error',
        message: 'Unable to load summary data. Please try again.',
      });
      setTimelineMetric({
        count: 0,
        status: 'error',
        message: 'Unable to load summary data. Please try again.',
      });
      setRecentArtifacts([]);
      setOpenLoopCount(0);
    } finally {
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setLastSyncISO(window.localStorage.getItem(LAST_SYNC_KEY));
  }, []);

  return (
    <div className={styles.dashboard}>
      {/* Metric row */}
      <div className={styles.metricRow}>
        <div className={styles.metricCard}>
          {timelineMetric.status === 'loading' ? (
            <Skeleton height="28px" width="48px" />
          ) : (
            <p className={styles.metricNum}>{timelineMetric.count}</p>
          )}
          <p className={styles.metricLbl}>Summaries generated</p>
        </div>
        <div className={styles.metricCard}>
          {timelineMetric.status === 'loading' ? (
            <Skeleton height="28px" width="48px" />
          ) : (
            <p className={styles.metricNum}>{openLoopCount}</p>
          )}
          <p className={styles.metricLbl}>Open loops</p>
        </div>
        <div className={styles.metricCard}>
          {calendarMetric.status === 'loading' ? (
            <Skeleton height="28px" width="48px" />
          ) : (
            <p className={styles.metricNum}>{calendarMetric.count}</p>
          )}
          <p className={styles.metricLbl}>Calendar entries</p>
        </div>
        <div className={styles.metricCard}>
          <p className={styles.metricNum}>{lastSyncLabel}</p>
          <p className={styles.metricLbl}>Last sync</p>
        </div>
      </div>

      {/* Quick actions */}
      <div className={styles.quickActions}>
        <a href="/select/drive" className={styles.qaCard}>
          <div className={`${styles.qaIcon} ${styles.qaIconBlue}`}>+</div>
          <div>
            <p className={styles.qaTitle}>Select documents</p>
            <p className={styles.qaSub}>Browse Drive or Gmail</p>
          </div>
        </a>
        <a href="/timeline" className={styles.qaCard}>
          <div className={`${styles.qaIcon} ${styles.qaIconTeal}`}>&#9654;</div>
          <div>
            <p className={styles.qaTitle}>View timeline</p>
            <p className={styles.qaSub}>
              {timelineMetric.count > 0
                ? `${timelineMetric.count} summaries ready`
                : 'Summarise your selections'}
            </p>
          </div>
        </a>
        <a href="/timeline/chat" className={styles.qaCard}>
          <div className={`${styles.qaIcon} ${styles.qaIconAmber}`}>?</div>
          <div>
            <p className={styles.qaTitle}>Ask a question</p>
            <p className={styles.qaSub}>Search your timeline</p>
          </div>
        </a>
      </div>

      {/* Recent summaries */}
      {recentArtifacts.length > 0 ? (
        <div>
          <p className={styles.recentLabel}>Recent summaries</p>
          {recentArtifacts.map((artifact) => {
            const dateLabel = artifact.contentDateISO ?? artifact.createdAtISO
              ? new Date(artifact.contentDateISO ?? artifact.createdAtISO ?? '').toLocaleDateString(
                  'en-GB',
                  { day: 'numeric', month: 'short' },
                )
              : null;
            return (
              <div key={artifact.artifactId} className={styles.recentItem}>
                <span
                  className={`${styles.sourceDot} ${artifact.source === 'gmail' ? styles.dotGmail : styles.dotDrive}`}
                />
                <span className={styles.recentTitle}>{artifact.title}</span>
                {(artifact.openLoops?.length ?? 0) > 0 ? (
                  <span className={styles.recentBadgeWarn}>Open loop</span>
                ) : (
                  <span className={styles.recentBadgeDone}>Summarised</span>
                )}
                {dateLabel ? <span className={styles.recentDate}>{dateLabel}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Connect CTA — keep existing behaviour */}
      {showConnectCta ? (
        <Button type="button" onClick={() => window.location.assign('/connect')}>
          Connect to get started
        </Button>
      ) : null}

      {/* Error states — keep existing behaviour */}
      {calendarMetric.status === 'error' ? (
        <div className={styles.inlineError}>
          <p>{calendarMetric.message}</p>
          <Button type="button" variant="secondary" onClick={() => loadSummary()}>
            Retry
          </Button>
        </div>
      ) : null}
      {timelineMetric.status === 'error' ? (
        <div className={styles.inlineError}>
          <p>{timelineMetric.message}</p>
          <Button type="button" variant="secondary" onClick={() => loadSummary()}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
