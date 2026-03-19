'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Skeleton from '../components/ui/Skeleton';
import styles from './gettingStarted.module.css';
import { chunkArray } from '../lib/chunkArray';

type StatusLabel = 'Not started' | 'Done' | 'Needs action';
type StepStatus = { loading: boolean; error: string | null };
type SelectionSetInfo = { driveFileId: string; name: string; updatedAtISO: string };

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? fallback;
  } catch {
    return fallback;
  }
};

export default function GettingStartedPageClient({ isAuthConfigured }: { isAuthConfigured: boolean }) {
  const { data: session, status } = useSession();
  const signedIn = status === 'authenticated';
  const [selectionSets, setSelectionSets] = useState<SelectionSetInfo[]>([]);
  const [artifactCount, setArtifactCount] = useState(0);
  const [statusLoading, setStatusLoading] = useState(true);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [provisionState, setProvisionState] = useState<StepStatus>({ loading: false, error: null });
  const [provisionSuccess, setProvisionSuccess] = useState<{ folderId: string; folderName: string } | null>(null);
  const [summarizeState, setSummarizeState] = useState<StepStatus>({ loading: false, error: null });
  const [summarizeMessage, setSummarizeMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'loading') return;
    if (!signedIn) {
      setStatusLoading(false);
      setSelectionSets([]);
      setArtifactCount(0);
      setSelectionError(null);
      setArtifactError(null);
      return;
    }
    let cancelled = false;
    const loadStatuses = async () => {
      setStatusLoading(true);
      setSelectionError(null);
      setArtifactError(null);
      const [selectionResponse, artifactResponse] = await Promise.all([
        fetch('/api/timeline/selection/list'),
        fetch('/api/timeline/artifacts/list'),
      ]);
      if (cancelled) return;
      if (!selectionResponse.ok) {
        setSelectionError(await parseErrorMessage(selectionResponse, 'Could not check selection status.'));
      } else {
        const payload = (await selectionResponse.json()) as { sets?: SelectionSetInfo[] };
        setSelectionSets(payload.sets ?? []);
      }
      if (!artifactResponse.ok) {
        setArtifactError(await parseErrorMessage(artifactResponse, 'Could not check summarize status.'));
      } else {
        const payload = (await artifactResponse.json()) as { artifacts?: unknown[] };
        setArtifactCount((payload.artifacts ?? []).length);
      }
      setStatusLoading(false);
    };
    void loadStatuses();
    return () => { cancelled = true; };
  }, [signedIn, status]);

  const driveFolderId = provisionSuccess?.folderId ?? session?.driveFolderId;
  const connected = signedIn;
  const provisioned = Boolean(driveFolderId);
  const hasSelections = selectionSets.length > 0;
  const hasArtifacts = artifactCount > 0;
  const newestSetId = useMemo(() => selectionSets.slice().sort((a,b)=>Date.parse(b.updatedAtISO)-Date.parse(a.updatedAtISO))[0]?.driveFileId, [selectionSets]);

  const toStepStatus = (done: boolean, canAct: boolean): StatusLabel => done ? 'Done' : (canAct ? 'Needs action' : 'Not started');
  const getStatusTone = (label: StatusLabel): 'neutral'|'success'|'warning' => label === 'Done' ? 'success' : label === 'Needs action' ? 'warning' : 'neutral';

  const handleProvision = async () => {
    setProvisionState({ loading: true, error: null });
    const response = await fetch('/api/google/drive/provision', { method: 'POST' });
    if (!response.ok) {
      setProvisionState({ loading: false, error: await parseErrorMessage(response, 'Unable to provision the Drive folder.') });
      return;
    }
    const payload = (await response.json()) as { folderId: string; folderName: string };
    setProvisionSuccess(payload);
    setProvisionState({ loading: false, error: null });
  };

  const SUMMARIZE_BATCH_SIZE = 10;

  const handleSummarize = async () => {
    if (!newestSetId) {
      setSummarizeState({ loading: false, error: 'Select documents first.' });
      return;
    }
    setSummarizeState({ loading: true, error: null });
    setSummarizeMessage(null);

    const setResponse = await fetch(`/api/timeline/selection/read?fileId=${encodeURIComponent(newestSetId)}`);
    if (!setResponse.ok) {
      setSummarizeState({ loading: false, error: await parseErrorMessage(setResponse, 'Could not read your latest selection set.') });
      return;
    }

    const setPayload = (await setResponse.json()) as { set?: { items?: Array<{ source: 'gmail' | 'drive'; id: string }> } };
    const items = setPayload.set?.items ?? [];

    if (!items.length) {
      setSummarizeState({ loading: false, error: 'Your latest selection set is empty. Add documents first.' });
      return;
    }

    const batches = chunkArray(items, SUMMARIZE_BATCH_SIZE);
    let totalCreated = 0;
    let totalFailed = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      setSummarizeMessage(
        batches.length > 1
          ? `Summarizing batch ${i + 1} of ${batches.length}…`
          : null
      );

      const summarizeResponse = await fetch('/api/timeline/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: batch.map((item) => ({ source: item.source, id: item.id })) }),
      });

      if (!summarizeResponse.ok) {
        setSummarizeState({
          loading: false,
          error: await parseErrorMessage(
            summarizeResponse,
            `Summarize failed on batch ${i + 1}. ${totalCreated} summaries created before the error.`
          ),
        });
        return;
      }

      const summarizePayload = (await summarizeResponse.json()) as { artifacts?: unknown[]; failed?: unknown[] };
      totalCreated += (summarizePayload.artifacts ?? []).length;
      totalFailed += (summarizePayload.failed ?? []).length;
    }

    setArtifactCount((current) => current + totalCreated);
    setSummarizeMessage(
      `Summarize complete: ${totalCreated} summary(ies) created${totalFailed ? `, ${totalFailed} failed` : ''}.`
    );
    setSummarizeState({ loading: false, error: null });
  };

  const step1Status = toStepStatus(connected, !connected || !isAuthConfigured);
  const step2Status = toStepStatus(provisioned, connected);
  const step3Status = toStepStatus(hasSelections, connected && provisioned);
  const step4Status = toStepStatus(hasArtifacts, connected && provisioned && hasSelections);
  const step5Status = toStepStatus(false, hasArtifacts);

  // Determine which step is the active one (first non-Done step)
  const stepStatuses = [step1Status, step2Status, step3Status, step4Status, step5Status];
  const activeStepIndex = stepStatuses.findIndex((s) => s !== 'Done');
  const allDone = activeStepIndex === -1;

  const stepMeta = [
    { label: 'Connect Google',        shortLabel: 'Connect' },
    { label: 'Provision Drive folder', shortLabel: 'Provision' },
    { label: 'Select documents',       shortLabel: 'Select' },
    { label: 'Summarize',              shortLabel: 'Summarize' },
    { label: 'Ask a question',         shortLabel: 'Ask' },
  ];

  return (
    <section className={styles.page}>
      <div>
        <h1>Getting started</h1>
        <p>Connect Google, pick 3 docs, summarize, then ask questions with citations.</p>
      </div>

      {/* Stepper bar */}
      <div className={styles.stepper} role="list">
        {stepMeta.map((meta, index) => {
          const status = stepStatuses[index];
          const stepClass =
            status === 'Done'
              ? styles.stepPillDone
              : index === activeStepIndex
                ? styles.stepPillActive
                : styles.stepPillFuture;
          return (
            <React.Fragment key={meta.label}>
              <div
                className={`${styles.stepPill} ${stepClass}`}
                role="listitem"
                aria-current={index === activeStepIndex ? 'step' : undefined}
              >
                <span className={styles.stepPillNum}>{index + 1}</span>
                <span className={styles.stepPillLabel}>{meta.shortLabel}</span>
              </div>
              {index < stepMeta.length - 1 && (
                <div
                  className={`${styles.stepConnector} ${status === 'Done' ? styles.stepConnectorDone : ''}`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Active step detail panel */}
      {allDone ? (
        <Card className={styles.detailPanel}>
          <h2 className={styles.detailTitle}>You&apos;re all set</h2>
          <p>All steps are complete. Head to Timeline to explore your summaries.</p>
          <div className={styles.detailActions}>
            <Link href="/timeline"><Button variant="primary">Open Timeline</Button></Link>
            <Link href="/timeline/chat"><Button variant="secondary">Open Chat</Button></Link>
          </div>
        </Card>
      ) : activeStepIndex === 0 ? (
        <Card className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>Connect Google</h2>
            <Badge tone={getStatusTone(step1Status)}>{step1Status}</Badge>
          </div>
          <p>Sign in and grant Google permissions so Timeline can read selected sources.</p>
          <div className={styles.detailActions}>
            <Link href="/connect" className={styles.linkButton}>{signedIn ? 'Connect' : 'Sign in'}</Link>
          </div>
          {!isAuthConfigured ? <p className={styles.inlineError}>Google auth is not configured in this environment.</p> : null}
        </Card>
      ) : activeStepIndex === 1 ? (
        <Card className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>Provision Drive folder</h2>
            <Badge tone={getStatusTone(step2Status)}>{step2Status}</Badge>
          </div>
          <p>Create the app folder that stores selection sets and summary artifacts.</p>
          <div className={styles.detailActions}>
            <Button onClick={handleProvision} disabled={!signedIn || provisionState.loading || provisioned}>
              {provisionState.loading ? 'Provisioning…' : 'Provision folder'}
            </Button>
          </div>
          {statusLoading && signedIn ? <Skeleton width="220px" /> : null}
          {provisionState.error ? <p className={styles.inlineError}>{provisionState.error}</p> : null}
          {driveFolderId ? (
            <p className={styles.folderMeta}>
              Folder ID: <code>{driveFolderId}</code>{' '}
              <a href={`https://drive.google.com/drive/folders/${driveFolderId}`} target="_blank" rel="noreferrer" className={styles.secondaryLink}>
                Open in Drive
              </a>
            </p>
          ) : null}
        </Card>
      ) : activeStepIndex === 2 ? (
        <Card className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>Select documents</h2>
            <Badge tone={getStatusTone(step3Status)}>{step3Status}</Badge>
          </div>
          <p>Pick a small starter set from Drive (and optionally Gmail) to summarize.</p>
          <div className={styles.detailActions}>
            <Link href="/select/drive" className={styles.linkButton}>Select from Drive</Link>
            <Link href="/select/gmail" className={styles.secondaryLink}>Use Gmail selection</Link>
          </div>
          {statusLoading && signedIn ? <Skeleton width="200px" /> : null}
          {selectionError ? <p className={styles.inlineError}>{selectionError}</p> : null}
          {!statusLoading && hasSelections ? <p className={styles.inlineInfo}>Found {selectionSets.length} saved selection set(s).</p> : null}
        </Card>
      ) : activeStepIndex === 3 ? (
        <Card className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>Summarize selection</h2>
            <Badge tone={getStatusTone(step4Status)}>{step4Status}</Badge>
          </div>
          <p>Create timeline-ready summaries from your latest selection set.</p>
          <div className={styles.detailActions}>
            <Button onClick={handleSummarize} disabled={!signedIn || summarizeState.loading || !hasSelections || !provisioned}>
              {summarizeState.loading ? 'Summarizing…' : 'Summarize now'}
            </Button>
            <Link href="/timeline?from=getting-started" className={styles.secondaryLink}>Open timeline flow</Link>
          </div>
          {artifactError ? <p className={styles.inlineError}>{artifactError}</p> : null}
          {summarizeState.error ? <p className={styles.inlineError}>{summarizeState.error}</p> : null}
          {summarizeMessage ? <p className={styles.inlineInfo}>{summarizeMessage}</p> : null}
        </Card>
      ) : (
        <Card className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <h2 className={styles.detailTitle}>Ask a timeline question</h2>
            <Badge tone={getStatusTone(step5Status)}>{step5Status}</Badge>
          </div>
          <p>Use chat to ask questions and get answers with citations from your summaries.</p>
          <div className={styles.detailActions}>
            <Link
              href={hasArtifacts ? '/timeline/chat' : '#'}
              className={styles.linkButton}
              aria-disabled={!hasArtifacts}
              onClick={(event) => { if (!hasArtifacts) event.preventDefault(); }}
            >
              Open chat
            </Link>
          </div>
          {!hasArtifacts ? <p className={styles.inlineInfo}>Summarize documents first.</p> : null}
        </Card>
      )}
    </section>
  );

}
