'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';

import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import { parseApiError } from '../../lib/apiErrors';
import { buildDriveQuery, type DriveMimeGroup, type DriveModifiedPreset } from '../../lib/driveQuery';
import type { DriveSelectionSet } from '../../lib/selectionSets';
import { hydrateDriveQueryControls } from './selectionSetHydration';
import {
  fileTypeBadge,
  formatBytes,
  formatRelativeTime,
  safeCopyToClipboard,
  type FileBadgeKind,
} from './formatters';
import styles from '../selection.module.css';
import SelectionBar from '../SelectionBar';

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  createdTime: string | null;
  size: string | null;
  webViewLink: string | null;
  owner: {
    name: string;
    email: string;
  };
  parents: string[];
};

type DriveSelectClientProps = {
  isConfigured: boolean;
};

type SavedSelectionSetMetadata = {
  id: string;
  title: string;
  updatedAt: string;
  kind?: string;
  source?: string;
};

const STORAGE_KEY = 'timeline.driveSelections';
const MAX_SELECTION_ITEMS = 500;
const MAX_SUMMARIZE_SELECTION = 20;
const TIMELINE_SUMMARIZE_BATCH_SIZE = 10;
const MAX_SAVED_SEARCH_PAGES = 5;
const MAX_SAVED_SEARCH_FILES = 50;


const badgeClassByKind: Record<FileBadgeKind, string> = {
  pdf: styles.fileBadgePdf,
  doc: styles.fileBadgeDoc,
  sheet: styles.fileBadgeSheet,
  slide: styles.fileBadgeSlide,
  image: styles.fileBadgeImage,
  folder: styles.fileBadgeFolder,
  other: styles.fileBadgeOther,
};

const parseStoredSelections = () => {
  if (typeof window === 'undefined') {
    return [] as DriveFile[];
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return [] as DriveFile[];
  }

  try {
    const parsed = JSON.parse(stored) as DriveFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as DriveFile[];
  }
};

export default function DriveSelectClient({ isConfigured }: DriveSelectClientProps) {
  const [nameContains, setNameContains] = useState('');
  const [mimeGroup, setMimeGroup] = useState<DriveMimeGroup>('any');
  const [modifiedPreset, setModifiedPreset] = useState<DriveModifiedPreset>('30d');
  const [modifiedAfter, setModifiedAfter] = useState('');
  const [inFolderId, setInFolderId] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [limitToAppFolder, setLimitToAppFolder] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRequestId, setSearchRequestId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<DriveFile[]>([]);
  const [searchSelectedIds, setSearchSelectedIds] = useState<string[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchSourceLabel, setSearchSourceLabel] = useState<string | null>(null);
  const [savedSets, setSavedSets] = useState<SavedSelectionSetMetadata[]>([]);
  const [savedSetsLoading, setSavedSetsLoading] = useState(false);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [saveSearchTitle, setSaveSearchTitle] = useState('');
  const [isSummarizingSelected, setIsSummarizingSelected] = useState(false);
  const [summarizeStatus, setSummarizeStatus] = useState<string | null>(null);
  const [summarizeError, setSummarizeError] = useState<'reconnect_required' | 'rate_limited' | 'server_error' | 'generic' | null>(null);
  const [summarizeRequestId, setSummarizeRequestId] = useState<string | null>(null);
  const [summarizedCount, setSummarizedCount] = useState<number | null>(null);
  const [summarizePartialStatus, setSummarizePartialStatus] = useState<string | null>(null);
  const [savedSearchToConfirm, setSavedSearchToConfirm] = useState<{ id: string; title: string } | null>(null);
  const [savedSearchStatus, setSavedSearchStatus] = useState<string | null>(null);
  const [savedSearchError, setSavedSearchError] = useState<'reconnect_required' | 'rate_limited' | 'server_error' | 'generic' | null>(null);
  const [savedSearchRequestId, setSavedSearchRequestId] = useState<string | null>(null);
  const [savedSearchSummarizedCount, setSavedSearchSummarizedCount] = useState<number | null>(null);
  const [savedSearchPartialStatus, setSavedSearchPartialStatus] = useState<string | null>(null);
  const [savedSearchCapNotice, setSavedSearchCapNotice] = useState<string | null>(null);
  const [savedSearchRetryTarget, setSavedSearchRetryTarget] = useState<{ id: string; title: string } | null>(null);
  const [isSummarizingSavedSearch, setIsSummarizingSavedSearch] = useState(false);
  const { data: session } = useSession();
  const router = useRouter();
  const driveFolderId = session?.driveFolderId?.trim() || '';
  const effectiveFolderId = limitToAppFolder ? driveFolderId : inFolderId;
  const [selectionSetId, setSelectionSetId] = useState<string | null>(null);
  const [selectionBarAuthRequired, setSelectionBarAuthRequired] = useState(false);
  const [selectionSaveLoading, setSelectionSaveLoading] = useState(false);
  const [selectionSaveError, setSelectionSaveError] = useState<string | null>(null);
  const [selectionSaveSuccess, setSelectionSaveSuccess] = useState<string | null>(null);
  const [selectionSummarizeLoading, setSelectionSummarizeLoading] = useState(false);
  const [selectionSummarizeError, setSelectionSummarizeError] = useState<string | null>(null);
  const [selectionSummarizeNote, setSelectionSummarizeNote] = useState<string | null>(null);

  const queryPreview = useMemo(
    () =>
      buildDriveQuery({
        nameContains,
        mimeGroup,
        modifiedPreset,
        modifiedAfter: modifiedAfter || null,
        inFolderId: effectiveFolderId || null,
        ownerEmail: ownerEmail || null,
      }),
    [effectiveFolderId, mimeGroup, modifiedAfter, modifiedPreset, nameContains, ownerEmail],
  );

  const searchSelectedSet = useMemo(() => new Set(searchSelectedIds), [searchSelectedIds]);
  const isAnySummarizing = isSummarizingSelected || isSummarizingSavedSearch;

  const loadSavedSelectionSets = async () => {
    setSavedSetsLoading(true);
    const response = await fetch('/api/saved-searches');
    if (response.status === 401 || response.status === 403) {
      setSearchError('reconnect_required');
      setSelectionBarAuthRequired(true);
      setSavedSetsLoading(false);
      return;
    }

    if (!response.ok) {
      setSavedSetsLoading(false);
      return;
    }

    const payload = (await response.json()) as { sets?: SavedSelectionSetMetadata[] };
    setSavedSets((payload.sets ?? []).filter((set) => set.kind === 'drive_selection_set' || set.source === 'drive'));
    setSavedSetsLoading(false);
  };

  useEffect(() => {
    if (!isConfigured) {
      return;
    }

    void loadSavedSelectionSets();
  }, [isConfigured]);

  const executeSearch = async ({ q, sourceLabel, pageToken }: { q: string; sourceLabel: string; pageToken: string | null }) => {
    const trimmedQuery = q.trim();
    if (!trimmedQuery) {
      setSearchError('Query cannot be empty.');
      return;
    }

    setSearchLoading(true);
    setSearchError(null);
    setSearchRequestId(null);

    const response = await fetch('/api/google/drive/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: trimmedQuery, pageSize: 50, pageToken }),
    });

    const payload = (await response.json()) as {
      ok?: boolean;
      code?: string;
      message?: string;
      requestId?: string;
      files?: DriveFile[];
      nextPageToken?: string | null;
      resultCount?: number;
    };

    if (!response.ok || payload.ok === false) {
      setSearchLoading(false);
      setSearchRequestId(payload.requestId ?? null);
      if (response.status === 401 || payload.code === 'reconnect_required') {
        setSearchError('reconnect_required');
        return;
      }

      if (payload.code === 'rate_limited') {
        setSearchError('Rate limited by Drive. Please wait a moment and retry.');
        return;
      }

      if (payload.requestId) {
        setSearchError(`Search failed. Please retry. Request ID: ${payload.requestId}`);
        return;
      }

      setSearchError(payload.message ?? 'Search failed.');
      return;
    }

    setSearchLoading(false);
    setSearchResults(payload.files ?? []);
    setSearchSelectedIds([]);
    setResultCount(payload.resultCount ?? payload.files?.length ?? 0);
    setNextPageToken(payload.nextPageToken ?? null);
    setSearchRequestId(payload.requestId ?? null);
    setSearchQuery(trimmedQuery);
    setSearchSourceLabel(sourceLabel);
  };

  const persistSelections = (items: DriveFile[]) => {
    const existing = parseStoredSelections();
    const mergedMap = new Map<string, DriveFile>();

    for (const item of existing) {
      mergedMap.set(item.id, item);
    }

    for (const item of items) {
      mergedMap.set(item.id, item);
    }

    const merged = Array.from(mergedMap.values()).slice(0, MAX_SELECTION_ITEMS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

    setNotice(
      `Saved ${items.length} file${items.length === 1 ? '' : 's'} to Timeline selection (${merged.length}/${MAX_SELECTION_ITEMS}).`,
    );
  };

  const summarizeItemsInBatches = async (items: Array<{ source: 'drive'; id: string }>, totalLabel: number) => {
    let totalArtifacts = 0;
    let totalFailed = 0;

    for (let offset = 0; offset < items.length; offset += TIMELINE_SUMMARIZE_BATCH_SIZE) {
      const batch = items.slice(offset, offset + TIMELINE_SUMMARIZE_BATCH_SIZE);
      const response = await fetch('/api/timeline/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: batch }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        const code = apiError?.code;
        setSummarizeRequestId(apiError?.requestId ?? null);
        if (code === 'reconnect_required') {
          setSummarizeError('reconnect_required');
        } else if (code === 'rate_limited') {
          setSummarizeError('rate_limited');
        } else if (response.status >= 500) {
          setSummarizeError('server_error');
        } else {
          setSummarizeError('generic');
        }

        setSummarizePartialStatus(
          totalArtifacts > 0
            ? `Summarized ${totalArtifacts} of ${totalLabel} files. ${totalLabel - totalArtifacts} failed.${
                apiError?.requestId ? ` (requestId: ${apiError.requestId})` : ''
              }`
            : null,
        );

        return { ok: false, artifacts: totalArtifacts, failed: totalLabel - totalArtifacts };
      }

      const summarizePayload = (await response.json()) as {
        artifacts?: Array<{ sourceId: string }>;
        failed?: Array<{ id: string }>;
      };

      totalArtifacts += summarizePayload.artifacts?.length ?? 0;
      totalFailed += summarizePayload.failed?.length ?? Math.max(batch.length - (summarizePayload.artifacts?.length ?? 0), 0);
      setSummarizeStatus(`Summarizing ${totalArtifacts} / ${totalLabel}…`);
    }

    return { ok: true, artifacts: totalArtifacts, failed: totalFailed };
  };

  const summarizeSelectedNow = async () => {
    const selected = searchResults.filter((file) => searchSelectedSet.has(file.id));
    if (selected.length === 0) {
      setSummarizeError('generic');
      setSummarizeStatus(null);
      return;
    }

    const capped = selected.slice(0, MAX_SUMMARIZE_SELECTION);
    setIsSummarizingSelected(true);
    setSummarizeStatus(`Summarizing 0 / ${capped.length}…`);
    setSummarizeError(null);
    setSummarizeRequestId(null);
    setSummarizedCount(null);
    setSummarizePartialStatus(null);

    const result = await summarizeItemsInBatches(
      capped.map((file) => ({ source: 'drive' as const, id: file.id })),
      capped.length,
    );

    setSummarizeStatus(null);
    if (result.ok) {
      setSummarizeError(null);
      setSummarizedCount(result.artifacts);
      if (result.failed > 0) {
        setSummarizePartialStatus(`Summarized ${result.artifacts} of ${capped.length} files. ${result.failed} failed.`);
      }
      setSearchSelectedIds([]);
    }

    setIsSummarizingSelected(false);
  };

  const summarizeSavedSearch = async (id: string, title: string) => {
    setIsSummarizingSavedSearch(true);
    setSavedSearchStatus(`Collecting files (page 1/${MAX_SAVED_SEARCH_PAGES})…`);
    setSavedSearchError(null);
    setSavedSearchRequestId(null);
    setSavedSearchSummarizedCount(null);
    setSavedSearchPartialStatus(null);
    setSavedSearchCapNotice(null);
    setSavedSearchRetryTarget(null);

    try {
      const setResponse = await fetch(`/api/saved-searches/${id}`);
      if (!setResponse.ok) {
        const apiError = await parseApiError(setResponse);
        setSavedSearchRequestId(apiError?.requestId ?? null);
        setSavedSearchError(apiError?.code === 'reconnect_required' ? 'reconnect_required' : 'generic');
        setSavedSearchRetryTarget({ id, title });
        setSavedSearchStatus(null);
        return;
      }

      const setPayload = (await setResponse.json()) as { set?: DriveSelectionSet };
      const query = setPayload.set?.query?.q?.trim();
      if (!query) {
        setSavedSearchError('generic');
        setSavedSearchStatus(null);
        return;
      }

      const collectedIds: string[] = [];
      let pageToken: string | null = null;
      let pageCount = 0;

      while (pageCount < MAX_SAVED_SEARCH_PAGES && collectedIds.length < MAX_SAVED_SEARCH_FILES) {
        pageCount += 1;
        setSavedSearchStatus(`Collecting files (page ${pageCount}/${MAX_SAVED_SEARCH_PAGES})…`);

        const response = await fetch('/api/google/drive/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: query, pageSize: 50, pageToken }),
        });

        if (!response.ok) {
          const apiError = await parseApiError(response);
          setSavedSearchRequestId(apiError?.requestId ?? null);
          if (apiError?.code === 'reconnect_required') {
            setSavedSearchError('reconnect_required');
          } else if (apiError?.code === 'rate_limited') {
            setSavedSearchError('rate_limited');
          } else if (response.status >= 500) {
            setSavedSearchError('server_error');
          } else {
            setSavedSearchError('generic');
          }
          setSavedSearchRetryTarget({ id, title });
          setSavedSearchStatus(null);
          return;
        }

        const payload = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string | null };
        for (const file of payload.files ?? []) {
          if (collectedIds.length >= MAX_SAVED_SEARCH_FILES) {
            break;
          }

          if (!collectedIds.includes(file.id)) {
            collectedIds.push(file.id);
          }
        }

        pageToken = payload.nextPageToken ?? null;
        if (!pageToken || collectedIds.length >= MAX_SAVED_SEARCH_FILES) {
          break;
        }
      }

      if (collectedIds.length === 0) {
        setSavedSearchSummarizedCount(0);
        setSavedSearchStatus(null);
        setSavedSearchToConfirm(null);
        return;
      }

      let totalArtifacts = 0;
      let totalFailed = 0;
      const totalItems = collectedIds.length;
      setSavedSearchStatus(`Summarizing ${totalArtifacts} / ${totalItems}…`);

      for (let offset = 0; offset < collectedIds.length; offset += TIMELINE_SUMMARIZE_BATCH_SIZE) {
        const batchIds = collectedIds.slice(offset, offset + TIMELINE_SUMMARIZE_BATCH_SIZE);
        const response = await fetch('/api/timeline/summarize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: batchIds.map((fileId) => ({ source: 'drive', id: fileId })) }),
        });

        if (!response.ok) {
          const apiError = await parseApiError(response);
          setSavedSearchRequestId(apiError?.requestId ?? null);
          if (apiError?.code === 'reconnect_required') {
            setSavedSearchError('reconnect_required');
          } else if (apiError?.code === 'rate_limited') {
            setSavedSearchError('rate_limited');
          } else if (response.status >= 500) {
            setSavedSearchError('server_error');
          } else {
            setSavedSearchError('generic');
          }
          setSavedSearchRetryTarget({ id, title });
          setSavedSearchStatus(null);
          return;
        }

        const summarizePayload = (await response.json()) as {
          artifacts?: Array<{ sourceId: string }>;
          failed?: Array<{ id: string }>;
        };
        const batchSuccess = summarizePayload.artifacts?.length ?? 0;
        const batchFailed = summarizePayload.failed?.length ?? Math.max(batchIds.length - batchSuccess, 0);
        totalArtifacts += batchSuccess;
        totalFailed += batchFailed;
        setSavedSearchStatus(`Summarizing ${totalArtifacts} / ${totalItems}…`);
      }

      setSavedSearchSummarizedCount(totalArtifacts);
      if (totalFailed > 0) {
        setSavedSearchPartialStatus(`Summarized ${totalArtifacts} of ${totalItems} files. ${totalFailed} failed.`);
      }
      if (collectedIds.length >= MAX_SAVED_SEARCH_FILES) {
        setSavedSearchCapNotice('Reached cap of 50 files. Refine your saved search or run again.');
      }
      setSavedSearchStatus(null);
      setSavedSearchError(null);
      setSavedSearchToConfirm(null);
    } catch {
      setSavedSearchStatus(null);
      setSavedSearchError('generic');
      setSavedSearchRequestId(null);
      setSavedSearchRetryTarget({ id, title });
    } finally {
      setIsSummarizingSavedSearch(false);
    }
  };

  const handleSearch = () => {
    setNotice(null);
    setSearchError(null);
    setSearchRequestId(null);
    void executeSearch({ q: queryPreview, sourceLabel: 'Manual search', pageToken: null });
  };

  const clearFilters = () => {
    setNameContains('');
    setMimeGroup('any');
    setModifiedPreset('30d');
    setModifiedAfter('');
    setInFolderId('');
    setOwnerEmail('');
    setLimitToAppFolder(false);
    setSearchResults([]);
    setSearchSelectedIds([]);
    setSearchError(null);
    setSearchRequestId(null);
    setResultCount(0);
    setNextPageToken(null);
    setSearchQuery(null);
    setSearchSourceLabel(null);
    setNotice('Filters cleared.');
  };

  const copyFileId = async (id: string) => {
    try {
      const copied = await safeCopyToClipboard(id);
      setNotice(copied ? 'Copied file ID.' : 'Unable to copy file ID.');
    } catch {
      setNotice('Unable to copy file ID.');
    }
  };

  const saveSelectionSet = async () => {
    const defaultTitle = nameContains ? `Drive: ${nameContains}` : 'Drive search';
    setSaveSearchTitle(defaultTitle);
    setSaveSearchOpen(true);
  };

  const confirmSaveSearch = async () => {
    const title = saveSearchTitle.trim();
    if (!title) return;
    const defaultTitle = nameContains ? `Drive: ${nameContains}` : 'Drive search';
    const response = await fetch('/api/saved-searches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'drive',
        title,
        query: {
          q: queryPreview,
          nameContains,
          mimeGroup,
          modifiedPreset,
          modifiedAfter: modifiedAfter || null,
          inFolderId: effectiveFolderId || null,
          ownerEmail: ownerEmail || null,
        },
      }),
    });

    if (!response.ok) {
      setNotice('Unable to save saved search. Please try again.');
    } else {
      setNotice(`Saved search "${title}".`);
      await loadSavedSelectionSets();
    }
    setSaveSearchOpen(false);
    setSaveSearchTitle('');
  };

  const applySavedSet = async (id: string) => {
    const response = await fetch(`/api/saved-searches/${id}`);
    if (!response.ok) {
      setNotice('Unable to load saved search.');
      return;
    }

    const payload = (await response.json()) as { set?: DriveSelectionSet };
    if (!payload.set || payload.set.kind !== 'drive_selection_set') {
      setNotice('Unable to load saved search.');
      return;
    }

    const hydrated = hydrateDriveQueryControls(payload.set);
    setNameContains(hydrated.nameContains);
    setMimeGroup(hydrated.mimeGroup);
    setModifiedPreset(hydrated.modifiedPreset);
    setModifiedAfter(hydrated.modifiedAfter);
    setInFolderId(hydrated.inFolderId);
    setOwnerEmail(hydrated.ownerEmail);
    setLimitToAppFolder(false);

    setSearchResults([]);
    setSearchSelectedIds([]);
    setSearchError(null);
    setSearchRequestId(null);
    setResultCount(0);
    setNextPageToken(null);
    setSearchQuery(null);
    setSearchSourceLabel(null);
    setNotice(`Loaded saved search "${payload.set.title}". Click Search to run it.`);
  };

  const runSavedSet = async (id: string, title: string) => {
    const response = await fetch(`/api/saved-searches/${id}`);
    if (!response.ok) {
      setNotice('Unable to load saved search.');
      return;
    }

    const payload = (await response.json()) as { set?: DriveSelectionSet };
    const q = payload.set?.query?.q?.trim();
    if (!q) {
      setNotice('Unable to load saved search.');
      return;
    }

    await executeSearch({ q, sourceLabel: `Saved search: ${title}`, pageToken: null });
  };


  const toSelectionItems = () =>
    searchResults
      .filter((file) => searchSelectedSet.has(file.id))
      .map((file) => ({
        source: 'drive' as const,
        id: file.id,
        title: file.name,
        dateISO: file.modifiedTime ?? undefined,
      }));

  const saveSelectionForBar = async () => {
    const items = toSelectionItems();
    if (items.length === 0) {
      setSelectionSaveError('Select items to continue.');
      return null;
    }

    setSelectionSaveLoading(true);
    setSelectionSaveError(null);
    setSelectionSaveSuccess(null);
    setSelectionSummarizeNote(null);

    const response = await fetch('/api/timeline/selection/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Drive selection (${new Date().toLocaleDateString()})`,
        items,
        driveFileId: selectionSetId ?? undefined,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      setSelectionBarAuthRequired(true);
      setSelectionSaveError('Sign in required.');
      setSelectionSaveLoading(false);
      return null;
    }

    if (!response.ok) {
      setSelectionSaveError('Unable to save selection set.');
      setSelectionSaveLoading(false);
      return null;
    }

    const payload = (await response.json()) as { set?: { driveFileId?: string } };
    const nextId = payload.set?.driveFileId ?? null;
    if (nextId) {
      setSelectionSetId(nextId);
      const url = new URL(window.location.href);
      url.searchParams.set('selectionSetId', nextId);
      window.history.replaceState({}, '', url.toString());
    }

    setSelectionSaveSuccess('Saved.');
    setSelectionSaveLoading(false);
    return nextId;
  };

  const summarizeFromBar = async () => {
    setSelectionSummarizeError(null);
    setSelectionSummarizeNote(null);
    setSelectionSummarizeLoading(true);

    const savedId = (await saveSelectionForBar()) ?? selectionSetId;
    const items = toSelectionItems().map((file) => ({ source: file.source, id: file.id }));

    if (items.length === 0) {
      setSelectionSummarizeLoading(false);
      return;
    }

    const response = await fetch('/api/timeline/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    if (response.status === 401 || response.status === 403) {
      setSelectionBarAuthRequired(true);
      setSelectionSummarizeError('Sign in required.');
      setSelectionSummarizeLoading(false);
      return;
    }

    if (!response.ok) {
      router.push(savedId ? `/timeline?from=select&selectionSetId=${savedId}` : '/timeline?from=select');
      setSelectionSummarizeNote('Summarization is started from Timeline.');
      setSelectionSummarizeLoading(false);
      return;
    }

    router.push(savedId ? `/timeline?from=select&selectionSetId=${savedId}` : '/timeline?from=select');
    setSelectionSummarizeLoading(false);
  };

  const reconnectNotice = (
    <div className={styles.notice}>
      Reconnect required. Please <Link href="/connect">connect your Google account</Link>.
    </div>
  );

  return (
    <section className={styles.page}>
      <div className={styles.header}>
        <div>
          <p>Build and run Drive searches, save them, and summarize matching files.</p>
          <h1>Drive selection</h1>
        </div>
        <div className={styles.actions}>
          <Badge tone="neutral">{searchSelectedIds.length} selected on page</Badge>
        </div>
      </div>

      {!isConfigured ? (
        <div className={styles.emptyState}>
          Google OAuth isn&apos;t configured yet. Add the required environment variables to enable
          Drive selection.
        </div>
      ) : null}

      {searchError === 'reconnect_required' ? reconnectNotice : null}
      {searchError && searchError !== 'reconnect_required' ? <div className={styles.notice}>{searchError}</div> : null}
      {notice ? <p className={styles.noticeSubtle}>{notice}</p> : null}

      <div className={styles.driveLayout}>
        <div className={styles.driveMain}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Filters</h2>
              <div className={styles.actions}>
                <Button onClick={clearFilters} variant="ghost" disabled={isAnySummarizing || searchLoading}>
                  Clear filters
                </Button>
                <Button onClick={handleSearch} variant="secondary" disabled={isAnySummarizing || searchLoading}>
                  Search
                </Button>
                <Button onClick={() => void saveSelectionSet()} variant="ghost" disabled={isAnySummarizing}>
                  Create saved search
                </Button>
              </div>
            </div>

            {/* Chip bar */}
            <div className={styles.chipBar}>
              {(
                [
                  { value: 'any', label: 'Any type' },
                  { value: 'doc', label: 'Docs' },
                  { value: 'pdf', label: 'PDFs' },
                  { value: 'sheet', label: 'Sheets' },
                  { value: 'slide', label: 'Slides' },
                ] as Array<{ value: DriveMimeGroup; label: string }>
              ).map(({ value, label }) => (
                <button
                  key={value}
                  className={`${styles.filterChip} ${mimeGroup === value ? styles.filterChipActive : ''}`}
                  onClick={() => {
                    setMimeGroup(value);
                    void executeSearch({
                      q: buildDriveQuery({
                        nameContains,
                        mimeGroup: value,
                        modifiedPreset,
                        modifiedAfter: modifiedAfter || null,
                        inFolderId: effectiveFolderId || null,
                        ownerEmail: ownerEmail || null,
                      }),
                      sourceLabel: 'Quick filter',
                      pageToken: null,
                    });
                  }}
                  disabled={isAnySummarizing || searchLoading}
                >
                  {label}
                </button>
              ))}
              <div className={styles.chipDivider} />
              {(
                [
                  { value: '7d', label: 'Last 7 days' },
                  { value: '30d', label: 'Last 30 days' },
                  { value: '90d', label: 'Last 90 days' },
                ] as Array<{ value: DriveModifiedPreset; label: string }>
              ).map(({ value, label }) => (
                <button
                  key={value}
                  className={`${styles.filterChip} ${modifiedPreset === value ? styles.filterChipActive : ''}`}
                  onClick={() => {
                    setModifiedPreset(value);
                    void executeSearch({
                      q: buildDriveQuery({
                        nameContains,
                        mimeGroup,
                        modifiedPreset: value,
                        modifiedAfter: modifiedAfter || null,
                        inFolderId: effectiveFolderId || null,
                        ownerEmail: ownerEmail || null,
                      }),
                      sourceLabel: 'Quick filter',
                      pageToken: null,
                    });
                  }}
                  disabled={isAnySummarizing || searchLoading}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Inline save-search form */}
            {saveSearchOpen ? (
              <div className={styles.inlineSaveForm}>
                <input
                  autoFocus
                  className={styles.inlineSaveInput}
                  value={saveSearchTitle}
                  onChange={(e) => setSaveSearchTitle(e.target.value)}
                  placeholder="Search name…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmSaveSearch();
                    if (e.key === 'Escape') {
                      setSaveSearchOpen(false);
                      setSaveSearchTitle('');
                    }
                  }}
                />
                <Button onClick={() => void confirmSaveSearch()} disabled={!saveSearchTitle.trim()}>
                  Save
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSaveSearchOpen(false);
                    setSaveSearchTitle('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : null}

            <div className={styles.filtersGrid}>
          <label className={styles.field}>
            Name contains
            <input className={styles.input} value={nameContains} onChange={(event) => setNameContains(event.target.value)} />
          </label>

          <label className={styles.field}>
            Type
            <select value={mimeGroup} onChange={(event) => setMimeGroup(event.target.value as DriveMimeGroup)}>
              <option value="any">Any</option>
              <option value="pdf">PDF</option>
              <option value="doc">Doc</option>
              <option value="sheet">Sheet</option>
              <option value="slide">Slide</option>
              <option value="image">Image</option>
              <option value="folder">Folder</option>
            </select>
          </label>

          <label className={styles.field}>
            Modified
            <select value={modifiedPreset} onChange={(event) => setModifiedPreset(event.target.value as DriveModifiedPreset)}>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="custom">Custom date</option>
            </select>
          </label>

          {modifiedPreset === 'custom' ? (
            <label className={styles.field}>
              Modified after
              <input type="date" value={modifiedAfter} onChange={(event) => setModifiedAfter(event.target.value)} />
            </label>
          ) : null}

          <label className={styles.field}>
            Folder ID (optional)
            <input
              className={styles.input}
              value={inFolderId}
              onChange={(event) => setInFolderId(event.target.value)}
              disabled={limitToAppFolder}
            />
          </label>

          <label className={styles.field}>
            Owner email (optional)
            <input className={styles.input} value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
          </label>

          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={limitToAppFolder}
              onChange={(event) => setLimitToAppFolder(event.target.checked)}
              disabled={!driveFolderId}
            />
            Limit to app folder
          </label>
            </div>

            {!driveFolderId ? <p className={styles.helperText}>Provision Drive folder on /connect.</p> : null}

            <div className={styles.previewBox}>
              <strong>Drive query</strong>
              <code>{queryPreview}</code>
            </div>
          </div>

          <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Saved searches</h2>
          {savedSetsLoading ? <span className={styles.muted}>Loading…</span> : null}
        </div>

        {savedSets.length === 0 ? <p className={styles.muted}>No saved searches yet.</p> : null}

        <div className={styles.savedSetList}>
          {savedSets.map((set) => (
            <div key={set.id} className={styles.savedSetItem}>
              <div>
                <div className={styles.savedSetTitle}>{set.title}</div>
                <p className={styles.itemMeta}>Updated {new Date(set.updatedAt).toLocaleString()}</p>
              </div>
              <div className={styles.savedSetActions}>
                <Button variant="secondary" onClick={() => void applySavedSet(set.id)} disabled={isAnySummarizing}>Apply</Button>
                <Button variant="secondary" onClick={() => void runSavedSet(set.id, set.title)} disabled={isAnySummarizing}>Run</Button>
                <Button variant="secondary" onClick={() => setSavedSearchToConfirm({ id: set.id, title: set.title })} disabled={isAnySummarizing}>Summarize</Button>
              </div>
              {savedSearchToConfirm?.id === set.id ? (
                <div className={styles.confirmPanel}>
                  <p>
                    This will summarize up to 50 files from this saved Drive search over up to 5 pages.
                  </p>
                  <div className={styles.actions}>
                    <Button className={styles.summarizeNowButton} onClick={() => void summarizeSavedSearch(set.id, set.title)} disabled={isAnySummarizing}>Confirm summarize</Button>
                    <Button variant="secondary" onClick={() => setSavedSearchToConfirm(null)} disabled={isAnySummarizing}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {savedSearchStatus ? <p className={styles.noticeSubtle}>{savedSearchStatus}</p> : null}
        {savedSearchSummarizedCount !== null ? (
          <p className={styles.noticeSuccess}>
            Summarized {savedSearchSummarizedCount} files. <Link href="/timeline">Open Timeline</Link>
          </p>
        ) : null}
        {savedSearchPartialStatus ? <p className={styles.noticeNeutral}>{savedSearchPartialStatus}</p> : null}
        {savedSearchCapNotice ? <p className={styles.noticeNeutral}>{savedSearchCapNotice}</p> : null}
        {savedSearchError === 'reconnect_required' ? <p className={styles.notice}>Google connection expired. <Link href="/connect">Reconnect</Link>.</p> : null}
        {savedSearchError === 'rate_limited' ? <p className={styles.noticeNeutral}>Drive rate limit reached. {savedSearchRetryTarget ? <button onClick={() => void summarizeSavedSearch(savedSearchRetryTarget.id, savedSearchRetryTarget.title)}>Retry</button> : null}</p> : null}
        {savedSearchError === 'server_error' ? <p className={styles.notice}>Unable to summarize saved search due to server error.{savedSearchRequestId ? ` Request ID: ${savedSearchRequestId}` : ''}</p> : null}
        {savedSearchError === 'generic' ? <p className={styles.notice}>Unable to summarize saved search.{savedSearchRequestId ? ` Request ID: ${savedSearchRequestId}` : ''}</p> : null}
          </div>

          {searchQuery ? (
            <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Results ({resultCount})</h2>
              <span className={styles.itemMeta}>{searchSourceLabel ?? 'Search'} · Query: {searchQuery}</span>
            </div>
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => setSearchSelectedIds(searchResults.map((file) => file.id))} disabled={searchResults.length === 0 || isAnySummarizing}>Select all (this page)</Button>
              <Button variant="secondary" onClick={() => setSearchSelectedIds([])} disabled={searchSelectedIds.length === 0 || isAnySummarizing}>Clear selection</Button>
              <Button variant="secondary" onClick={() => persistSelections(searchResults.filter((file) => searchSelectedSet.has(file.id)))} disabled={searchSelectedIds.length === 0 || isAnySummarizing}>Add selected to Timeline</Button>
              <Button variant="secondary" onClick={() => persistSelections(searchResults)} disabled={searchResults.length === 0 || isAnySummarizing}>Add all (this page) to Timeline</Button>
              <Button onClick={() => void summarizeSelectedNow()} className={styles.summarizeNowButton} disabled={searchSelectedIds.length === 0 || isAnySummarizing}>Summarize selected now</Button>
            </div>
          </div>

          {searchSelectedIds.length > MAX_SUMMARIZE_SELECTION ? (
            <p className={styles.noticeWarning}>Select up to 20 files to summarize at once.</p>
          ) : null}

          {summarizeStatus ? <p className={styles.noticeSubtle}>{summarizeStatus}</p> : null}
          {summarizedCount !== null ? <p className={styles.noticeSuccess}>Summarized {summarizedCount} files. <Link href="/timeline">Open Timeline</Link></p> : null}
          {summarizePartialStatus ? <p className={styles.noticeNeutral}>{summarizePartialStatus}</p> : null}
          {summarizeError === 'reconnect_required' ? <p className={styles.notice}>Google connection expired. <Link href="/connect">Reconnect</Link>.</p> : null}
          {summarizeError === 'rate_limited' ? <p className={styles.noticeNeutral}>Summarize rate limit reached. Please wait and retry.</p> : null}
          {summarizeError === 'server_error' ? <p className={styles.notice}>Unable to summarize selected files due to server error.{summarizeRequestId ? ` Request ID: ${summarizeRequestId}` : ''}</p> : null}
          {summarizeError === 'generic' ? <p className={styles.notice}>Unable to summarize selected files.{summarizeRequestId ? ` Request ID: ${summarizeRequestId}` : ''}</p> : null}

          {searchLoading ? <p className={styles.muted}>Searching Drive…</p> : null}
          {searchRequestId ? <p className={styles.noticeSubtle}>Request ID: {searchRequestId}</p> : null}

          <div className={styles.list}>
            {searchResults.length === 0 ? (
              <div className={styles.emptyState}>No files found. Try removing filters or widening date range.</div>
            ) : null}
            {searchResults.map((file) => (
              <label key={file.id} className={`${styles.item} ${searchSelectedSet.has(file.id) ? styles.rowSelected : ''}`}>
                <input
                  type="checkbox"
                  checked={searchSelectedSet.has(file.id)}
                  onChange={() =>
                    setSearchSelectedIds((prev) =>
                      prev.includes(file.id) ? prev.filter((id) => id !== file.id) : [...prev, file.id],
                    )
                  }
                />
                <div>
                  <div className={styles.itemHeader}>
                    <div className={styles.actions}>
                      <strong>{file.name}</strong>
                      {(() => {
                        const badge = fileTypeBadge(file.mimeType);
                        return <span className={`${styles.fileBadge} ${badgeClassByKind[badge.kind]}`}>{badge.label}</span>;
                      })()}
                    </div>
                    <div className={styles.rowActions}>
                      {file.webViewLink ? (
                        <a
                          href={file.webViewLink}
                          target="_blank"
                          rel="noopener"
                          className={styles.openLink}
                          aria-label={`Open ${file.name} in Drive`}
                        >
                          Open in Drive
                        </a>
                      ) : null}
                      <button
                        type="button"
                        className={styles.copyButton}
                        onClick={() => void copyFileId(file.id)}
                        aria-label={`Copy file ID for ${file.name}`}
                      >
                        Copy file ID
                      </button>
                    </div>
                  </div>
                  <p className={styles.metaLine}>
                    <span>Owner: {file.owner.name || file.owner.email || 'Unknown'}{file.owner.name && file.owner.email ? ` (${file.owner.email})` : ''}</span>
                    <span title={file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : undefined}>
                      Modified: {formatRelativeTime(file.modifiedTime)}
                    </span>
                    <span>Size: {formatBytes(file.size ? Number(file.size) : undefined)}</span>
                  </p>
                </div>
              </label>
            ))}
          </div>

          {nextPageToken ? (
            <Button
              variant="secondary"
              onClick={() => {
                if (!searchQuery) {
                  setNotice('No active query. Run a search first.');
                  return;
                }

                void executeSearch({ q: searchQuery, sourceLabel: searchSourceLabel ?? 'Search', pageToken: nextPageToken });
              }}
              disabled={searchLoading || isAnySummarizing}
            >
              Next page
            </Button>
          ) : null}
            </div>
          ) : null}
        </div>

        <aside className={styles.selPanel}>
          <p className={styles.selPanelLabel}>Selection</p>
          <p className={styles.selPanelCount}>
            {searchSelectedIds.length}
            <span className={styles.selPanelTotal}> selected</span>
          </p>
          {searchSelectedIds.length > 0 ? (
            <div className={styles.selList}>
              {searchResults
                .filter((f) => searchSelectedSet.has(f.id))
                .slice(0, 6)
                .map((f) => (
                  <div key={f.id} className={styles.selListItem}>
                    <span className={styles.selListName}>{f.name}</span>
                  </div>
                ))}
              {searchSelectedIds.length > 6 ? (
                <div className={styles.selListMore}>+{searchSelectedIds.length - 6} more</div>
              ) : null}
            </div>
          ) : (
            <p className={styles.selPanelEmpty}>No files selected yet. Search and tick files to add them.</p>
          )}
          <div className={styles.selPanelActions}>
            <Button
              aria-label="Summarize selected (panel)"
              onClick={() => void summarizeSelectedNow()}
              disabled={searchSelectedIds.length === 0 || isAnySummarizing}
            >
              {isSummarizingSelected ? (summarizeStatus ?? 'Summarizing…') : 'Summarize selected'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => persistSelections(searchResults.filter((f) => searchSelectedSet.has(f.id)))}
              disabled={searchSelectedIds.length === 0 || isAnySummarizing}
            >
              Add to Timeline
            </Button>
          </div>
          {summarizeError ? (
            <p className={styles.selPanelError}>
              {summarizeError === 'reconnect_required' ? 'Reconnect required.' : 'Summarize failed.'}
            </p>
          ) : null}
          {summarizedCount !== null ? (
            <p className={styles.selPanelSuccess}>
              {summarizedCount} file{summarizedCount !== 1 ? 's' : ''} summarised.{' '}
              <Link href="/timeline">Open Timeline</Link>
            </p>
          ) : null}
        </aside>
      </div>

      <SelectionBar
        selectedCount={searchSelectedIds.length}
        unauthorized={selectionBarAuthRequired}
        onSave={saveSelectionForBar}
        onSummarize={summarizeFromBar}
        saveLoading={selectionSaveLoading}
        summarizeLoading={selectionSummarizeLoading}
        saveError={selectionSaveError}
        summarizeError={selectionSummarizeError}
        saveSuccess={selectionSaveSuccess}
        summarizeNote={selectionSummarizeNote}
      />
    </section>
  );
}
