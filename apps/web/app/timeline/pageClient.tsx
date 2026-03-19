'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { artifactKey, mergeArtifacts } from '../lib/artifactMerge';
import { API_ERROR_CODES, parseApiError } from '../lib/apiErrors';
import { chunkArray } from '../lib/chunkArray';
import type { TimelineIndex } from '../lib/indexTypes';
import { mergeSelectionItems } from '../lib/selectionMerge';
import {
  buildTimelineEntries,
  filterEntries,
  groupEntries,
  sortEntries,
  type TimelineFilters,
  type TimelineGroupMode,
  type TimelineSelectionInput,
} from '../lib/timelineView';
import type { SelectionSet, SelectionSetItem, SummaryArtifact } from '../lib/types';
import { isSummaryArtifact, normalizeArtifact } from '../lib/validateArtifact';
import { detectPotentialConflicts } from '../lib/timeline/conflicts';
import {
  buildEntityIndex,
  filterArtifactsByEntity,
  normalizeEntityQueryParam,
} from '../lib/timeline/entities';
import RunsPanel from './RunsPanel';
import TimelineView from './TimelineView';
import RecentExports from './RecentExports';
import TimelineQuality from './TimelineQuality';
import MissingInfo from './MissingInfo';
import PotentialConflicts from './PotentialConflicts';
import EntityFilter from './EntityFilter';
import ArtifactDetailsDrawer from './ArtifactDetailsDrawer';
import styles from './timeline.module.css';

type FilterMode = 'all' | 'open-loops' | 'decisions' | 'actions' | 'drive' | 'gmail';
type TimelineDisplayMode = 'summaries' | 'timeline';
type ExportFormat = 'pdf' | 'drive';

type GmailSelection = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
};

type DriveSelection = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
};

type ApiSurfaceError =
  | 'reconnect_required'
  | 'drive_not_provisioned'
  | 'forbidden_outside_folder'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'too_many_items'
  | 'invalid_request'
  | 'provider_not_configured'
  | 'provider_bad_output'
  | 'generic'
  | null;

type SummarizeError = ApiSurfaceError;
type SyncError = ApiSurfaceError;
type SelectionSetError = ApiSurfaceError;

type FailedItem = {
  source: 'gmail' | 'drive';
  id: string;
  error: string;
};

const getFailedItemLabel = (item: FailedItem): { reason: string; hint: string } => {
  const err = item.error ?? '';
  if (err.startsWith('unsupported_content_type')) {
    const mimeMatch = err.match(/MIME type (.+)/);
    const mime = mimeMatch?.[1] ?? 'this file type';
    return {
      reason: `Unsupported file type (${mime})`,
      hint: 'Open in Drive, export to Google Docs format, then re-select.',
    };
  }
  if (err.includes('provider_bad_output')) {
    return {
      reason: 'AI returned an unexpected response',
      hint: 'Try summarising this item again.',
    };
  }
  if (err.includes('provider_not_configured')) {
    return {
      reason: 'AI provider not configured',
      hint: 'Go to Admin → Settings and set a provider.',
    };
  }
  if (err.includes('too_large') || err.includes('PayloadLimit')) {
    return {
      reason: 'File too large to store',
      hint: 'Select a smaller document or export a section of it.',
    };
  }
  if (err.includes('upstream_timeout') || err.includes('timeout')) {
    return {
      reason: 'Request timed out',
      hint: 'Google Drive was slow to respond — try again.',
    };
  }
  if (err.includes('insufficient_text')) {
    return {
      reason: 'Not enough text to summarise',
      hint: 'This file may be empty, an image, or a scanned PDF without OCR text.',
    };
  }
  return {
    reason: 'Summarise failed',
    hint: 'Try again, or check the file is accessible in Drive.',
  };
};

type SelectionSetSummary = {
  driveFileId: string;
  name: string;
  updatedAtISO: string;
  driveWebViewLink?: string;
};

type SearchType = 'all' | 'summary' | 'selection';

type TimelineSearchResult = {
  kind: 'summary' | 'selection';
  driveFileId: string;
  driveWebViewLink?: string;
  title: string;
  updatedAtISO?: string;
  source?: 'gmail' | 'drive';
  sourceId?: string;
  createdAtISO?: string;
  snippet: string;
  matchFields: string[];
};

type SearchError =
  | 'reconnect_required'
  | 'drive_not_provisioned'
  | 'forbidden_outside_folder'
  | 'query_too_short'
  | 'query_too_long'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'generic'
  | null;

type IndexError = ApiSurfaceError;
type ActionDecisionError = string | null;
type ActionCalendarEvent = {
  id: string;
  htmlLink: string;
  startISO: string;
  endISO: string;
  createdAtISO: string;
};

type ActionDecisionResponse = {
  ok: true;
  artifactId: string;
  actionId: string;
  status: 'accepted' | 'dismissed';
  calendarEvent?: ActionCalendarEvent;
};

const GMAIL_KEY = 'timeline.gmailSelections';
const DRIVE_KEY = 'timeline.driveSelections';
const ARTIFACTS_KEY = 'timeline.summaryArtifacts';
const AUTO_SYNC_KEY = 'timeline.autoSyncOnOpen';
const LAST_SYNC_KEY = 'timeline.lastSyncISO';
const GROUPING_KEY = 'timeline.groupingMode';
const FILTERS_KEY = 'timeline.filters';
const ENTITY_FILTER_KEY = 'timeline.entityFilter';
const SELECTION_VERSION_KEY = 'timeline.selectionVersion';
const CURRENT_SELECTION_VERSION = 2;
const ARTIFACT_LIMIT = 100;
const DEFAULT_FILTERS: TimelineFilters = {
  source: 'all',
  status: 'all',
  kind: 'all',
  tag: 'all',
  text: '',
  entity: '',
  hasOpenLoops: false,
  hasRisks: false,
  hasDecisions: false,
  riskSeverity: 'all',
  dateFromISO: '',
  dateToISO: '',
};

const RequestIdNote = ({ requestId }: { requestId?: string | null }) =>
  requestId ? (
    <span className={styles.requestId}>
      Request ID: <code>{requestId}</code>
    </span>
  ) : null;


const isValidGmailSelection = (value: unknown): value is GmailSelection => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.subject === 'string';
};

const isValidDriveSelection = (value: unknown): value is DriveSelection => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
};

const clearStoredSelections = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(GMAIL_KEY);
  window.localStorage.removeItem(DRIVE_KEY);
};

const migrateSelectionStorage = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  const storedVersion = Number(window.localStorage.getItem(SELECTION_VERSION_KEY) ?? '0');
  if (storedVersion >= CURRENT_SELECTION_VERSION) {
    return false;
  }

  const gmailRaw = parseStoredSelections<unknown>(GMAIL_KEY);
  const driveRaw = parseStoredSelections<unknown>(DRIVE_KEY);
  const gmailValid = gmailRaw.every(isValidGmailSelection);
  const driveValid = driveRaw.every(isValidDriveSelection);

  if (!gmailValid || !driveValid) {
    clearStoredSelections();
    window.localStorage.setItem(SELECTION_VERSION_KEY, String(CURRENT_SELECTION_VERSION));
    return true;
  }

  window.localStorage.setItem(SELECTION_VERSION_KEY, String(CURRENT_SELECTION_VERSION));
  return false;
};

const parseStoredSelections = <T,>(key: string) => {
  if (typeof window === 'undefined') {
    return [] as T[];
  }

  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return [] as T[];
  }

  try {
    const parsed = JSON.parse(stored) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as T[];
  }
};

const parseStoredArtifacts = () => {
  if (typeof window === 'undefined') {
    return {} as Record<string, SummaryArtifact>;
  }

  const stored = window.localStorage.getItem(ARTIFACTS_KEY);
  if (!stored) {
    return {} as Record<string, SummaryArtifact>;
  }

  try {
    const parsed = JSON.parse(stored) as Record<string, SummaryArtifact>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {} as Record<string, SummaryArtifact>;
  }
};

const parseStoredGrouping = (): TimelineGroupMode => {
  if (typeof window === 'undefined') {
    return 'day';
  }
  const stored = window.localStorage.getItem(GROUPING_KEY);
  if (stored === 'day' || stored === 'week' || stored === 'month') {
    return stored;
  }
  return 'day';
};

const parseStoredFilters = (): TimelineFilters => {
  if (typeof window === 'undefined') {
    return DEFAULT_FILTERS;
  }
  const stored = window.localStorage.getItem(FILTERS_KEY);
  if (!stored) {
    return DEFAULT_FILTERS;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<TimelineFilters>;
    return {
      ...DEFAULT_FILTERS,
      ...parsed,
      text: typeof parsed?.text === 'string' ? parsed.text : '',
      entity: typeof parsed?.entity === 'string' ? parsed.entity : '',
      hasOpenLoops: Boolean(parsed?.hasOpenLoops),
      hasRisks: Boolean(parsed?.hasRisks),
      hasDecisions: Boolean(parsed?.hasDecisions),
      riskSeverity: parsed?.riskSeverity === 'low' || parsed?.riskSeverity === 'medium' || parsed?.riskSeverity === 'high' ? parsed.riskSeverity : 'all',
      dateFromISO: typeof parsed?.dateFromISO === 'string' ? parsed.dateFromISO : '',
      dateToISO: typeof parsed?.dateToISO === 'string' ? parsed.dateToISO : '',
    };
  } catch {
    return DEFAULT_FILTERS;
  }
};

const persistArtifacts = (
  updates: SummaryArtifact[],
  existing: Record<string, SummaryArtifact>,
): Record<string, SummaryArtifact> => {
  const merged = mergeArtifacts(existing, updates, ARTIFACT_LIMIT);
  window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(merged));
  return merged;
};


const parseBooleanParam = (value: string | null) => value === '1' || value === 'true';

const toEpochMs = (value?: string) => {
  if (!value) {
    return Number.NaN;
  }
  return new Date(value).getTime();
};

const computeNextCursorISO = (
  artifacts: SummaryArtifact[],
  files: Array<{ id?: string; modifiedTime?: string }>,
): string => {
  const now = new Date().toISOString();
  const modifiedByFileId = new Map<string, string | undefined>();
  files.forEach((file) => {
    if (!file.id) {
      return;
    }
    modifiedByFileId.set(file.id, file.modifiedTime);
  });

  let maxMs = Number.NaN;
  let maxISO: string | null = null;

  artifacts.forEach((artifact) => {
    const maybeUpdatedAtISO =
      'updatedAtISO' in artifact ? (artifact as SummaryArtifact & { updatedAtISO?: string }).updatedAtISO : undefined;
    const candidates = [
      maybeUpdatedAtISO,
      artifact.createdAtISO,
      modifiedByFileId.get(artifact.driveFileId),
    ];

    candidates.forEach((candidate) => {
      const candidateMs = toEpochMs(candidate);
      if (!Number.isFinite(candidateMs)) {
        return;
      }
      if (!Number.isFinite(maxMs) || candidateMs > maxMs) {
        maxMs = candidateMs;
        maxISO = new Date(candidateMs).toISOString();
      }
    });
  });

  return maxISO ?? now;
};

const buildSelectionItems = (
  gmailSelections: GmailSelection[],
  driveSelections: DriveSelection[],
): SelectionSetItem[] => [
  ...gmailSelections.map((message) => ({
    source: 'gmail' as const,
    id: message.id,
    title: message.subject,
    dateISO: message.date,
  })),
  ...driveSelections.map((file) => ({
    source: 'drive' as const,
    id: file.id,
    title: file.name,
    dateISO: file.modifiedTime,
  })),
];

const selectionItemsToSelections = (
  items: SelectionSetItem[],
  gmailSelections: GmailSelection[],
  driveSelections: DriveSelection[],
) => {
  const gmailById = new Map(gmailSelections.map((message) => [message.id, message]));
  const driveById = new Map(driveSelections.map((file) => [file.id, file]));

  const nextGmail: GmailSelection[] = [];
  const nextDrive: DriveSelection[] = [];

  items.forEach((item) => {
    if (item.source === 'gmail') {
      const existing = gmailById.get(item.id);
      nextGmail.push(
        existing ?? {
          id: item.id,
          threadId: item.id,
          subject: item.title ?? 'Untitled message',
          from: 'From unavailable',
          date: item.dateISO ?? '',
          snippet: '',
        },
      );
      return;
    }

    const existing = driveById.get(item.id);
    nextDrive.push(
      existing ?? {
        id: item.id,
        name: item.title ?? 'Untitled file',
        mimeType: 'application/octet-stream',
        modifiedTime: item.dateISO,
      },
    );
  });

  return { gmail: nextGmail, drive: nextDrive };
};

export default function TimelinePageClient() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const jumpedArtifactRef = useRef<string | null>(null);
  const syncAttemptedArtifactRef = useRef<string | null>(null);
  const syncToastArtifactRef = useRef<string | null>(null);
  const [gmailSelections, setGmailSelections] = useState<GmailSelection[]>([]);
  const [driveSelections, setDriveSelections] = useState<DriveSelection[]>([]);
  const [artifacts, setArtifacts] = useState<Record<string, SummaryArtifact>>({});
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summarizeBatchLabel, setSummarizeBatchLabel] = useState<string | null>(null);
  const [error, setError] = useState<SummarizeError>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [selectionMigrationWarning, setSelectionMigrationWarning] = useState(false);
  const [failedItems, setFailedItems] = useState<FailedItem[]>([]);
  const [summarizeCooldownUntil, setSummarizeCooldownUntil] = useState<number | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<SyncError>(null);
  const [syncRequestId, setSyncRequestId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [autoSyncOnOpen, setAutoSyncOnOpen] = useState(false);
  const [lastSyncISO, setLastSyncISO] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [groupingMode, setGroupingMode] = useState<TimelineGroupMode>('day');
  const [displayMode, setDisplayMode] = useState<TimelineDisplayMode>('summaries');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [entityFilter, setEntityFilter] = useState<string | null>(null);
  const [appliedSetMessage, setAppliedSetMessage] = useState<string | null>(null);
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null);
  const [selectionSets, setSelectionSets] = useState<SelectionSetSummary[]>([]);
  const [isLoadingSets, setIsLoadingSets] = useState(false);
  const [selectionError, setSelectionError] = useState<SelectionSetError>(null);
  const [selectionRequestId, setSelectionRequestId] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<SelectionSet | null>(null);
  const [previewError, setPreviewError] = useState<SelectionSetError>(null);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNotes, setSaveNotes] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveToExisting, setSaveToExisting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [searchResults, setSearchResults] = useState<TimelineSearchResult[]>([]);
  const [searchError, setSearchError] = useState<SearchError>(null);
  const [searchRequestId, setSearchRequestId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchPartial, setSearchPartial] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const [pendingArtifactId, setPendingArtifactId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [indexData, setIndexData] = useState<TimelineIndex | null>(null);
  const [indexStale, setIndexStale] = useState(false);
  const [isIndexLoading, setIsIndexLoading] = useState(false);
  const [isIndexRefreshing, setIsIndexRefreshing] = useState(false);
  const [indexError, setIndexError] = useState<IndexError>(null);
  const [actionError, setActionError] = useState<ActionDecisionError>(null);
  const [actionErrorsByKey, setActionErrorsByKey] = useState<Record<string, string>>({});
  const [pendingActionKeys, setPendingActionKeys] = useState<Set<string>>(new Set());
  const [pendingOpenLoopKeys, setPendingOpenLoopKeys] = useState<Set<string>>(new Set());
  const [openLoopErrorsByKey, setOpenLoopErrorsByKey] = useState<Record<string, string>>({});
  const [indexRequestId, setIndexRequestId] = useState<string | null>(null);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [exportDriveLink, setExportDriveLink] = useState<string | null>(null);
  const timelineTopRef = useRef<HTMLDivElement | null>(null);

  const driveFolderId = session?.driveFolderId;
  const selectionSetIdParam = searchParams?.get('selectionSetId') ?? null;
  const fromSelect = searchParams?.get('from') === 'select';
  const runIdParam = searchParams?.get('runId') ?? null;
  const driveFolderLink = driveFolderId
    ? `https://drive.google.com/drive/folders/${driveFolderId}`
    : null;

  useEffect(() => {
    const didMigrateSelections = migrateSelectionStorage();
    setSelectionMigrationWarning(didMigrateSelections);
    setGmailSelections(parseStoredSelections<GmailSelection>(GMAIL_KEY));
    setDriveSelections(parseStoredSelections<DriveSelection>(DRIVE_KEY));
    setArtifacts(parseStoredArtifacts());
    setAutoSyncOnOpen(window.localStorage.getItem(AUTO_SYNC_KEY) === 'true');
    setLastSyncISO(window.localStorage.getItem(LAST_SYNC_KEY));
    setGroupingMode(parseStoredGrouping());
    setFilters(parseStoredFilters());
    const storedEntity = normalizeEntityQueryParam(window.localStorage.getItem(ENTITY_FILTER_KEY));
    const urlEntity = normalizeEntityQueryParam(searchParams?.get('entity') ?? null);
    setEntityFilter(urlEntity ?? storedEntity);
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!summarizeCooldownUntil) {
      return;
    }

    const delay = summarizeCooldownUntil - Date.now();
    if (delay <= 0) {
      setSummarizeCooldownUntil(null);
      return;
    }

    const handle = window.setTimeout(() => setSummarizeCooldownUntil(null), delay);
    return () => window.clearTimeout(handle);
  }, [summarizeCooldownUntil]);

  const selectionInputs = useMemo<TimelineSelectionInput[]>(
    () => [
      ...gmailSelections.map((message) => ({
        source: 'gmail' as const,
        id: message.id,
        title: message.subject,
        dateISO: message.date,
        metadata: {
          from: message.from,
          subject: message.subject,
        },
      })),
      ...driveSelections.map((file) => ({
        source: 'drive' as const,
        id: file.id,
        title: file.name,
        dateISO: file.modifiedTime,
        metadata: {
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
        },
      })),
    ],
    [driveSelections, gmailSelections],
  );

  const mergedSelectionInputs = useMemo<TimelineSelectionInput[]>(() => {
    const baseSelections = selectionInputs;
    const selectionKeys = new Set(
      baseSelections.map((selection) => artifactKey(selection.source, selection.id)),
    );

    const derivedSelectionsFromArtifacts = Object.values(artifacts)
      .filter((artifact) => !selectionKeys.has(artifactKey(artifact.source, artifact.sourceId)))
      .map((artifact) => ({
        source: artifact.source,
        id: artifact.sourceId,
        title: artifact.title,
        dateISO: artifact.createdAtISO,
        metadata: {
          from: artifact.sourceMetadata?.from,
          subject: artifact.sourceMetadata?.subject,
          mimeType: artifact.sourceMetadata?.mimeType,
          modifiedTime: artifact.sourceMetadata?.driveModifiedTime,
        },
      }));

    return [...baseSelections, ...derivedSelectionsFromArtifacts];
  }, [artifacts, selectionInputs]);

  const timelineEntries = useMemo(
    () => buildTimelineEntries(mergedSelectionInputs, artifacts, indexData),
    [artifacts, indexData, mergedSelectionInputs],
  );

  const sortedEntries = useMemo(() => sortEntries(timelineEntries), [timelineEntries]);
  const filteredEntries = useMemo(
    () => filterEntries(sortedEntries, filters),
    [filters, sortedEntries],
  );
  const visibleArtifactsBase = useMemo(
    () =>
      filteredEntries
        .map((entry) => {
          const artifact = artifacts[entry.key];
          if (!artifact) {
            return null;
          }
          return {
            entryKey: entry.key,
            artifact,
          };
        })
        .filter((value): value is { entryKey: string; artifact: SummaryArtifact } =>
          Boolean(value),
        ),
    [artifacts, filteredEntries],
  );
  const { entities: indexedEntities, counts: entityCounts } = useMemo(
    () => buildEntityIndex(visibleArtifactsBase),
    [visibleArtifactsBase],
  );
  const visibleArtifacts = useMemo(
    () => (entityFilter ? filterArtifactsByEntity(visibleArtifactsBase, entityFilter) : visibleArtifactsBase),
    [entityFilter, visibleArtifactsBase],
  );
  const filteredArtifacts = useMemo(() => {
    if (filterMode === 'all') return visibleArtifacts;
    if (filterMode === 'drive') return visibleArtifacts.filter((a) => a.artifact.source === 'drive');
    if (filterMode === 'gmail') return visibleArtifacts.filter((a) => a.artifact.source === 'gmail');
    if (filterMode === 'open-loops') return visibleArtifacts.filter((a) => (a.artifact.openLoops?.length ?? 0) > 0);
    if (filterMode === 'decisions') return visibleArtifacts.filter((a) => (a.artifact.decisions?.length ?? 0) > 0);
    if (filterMode === 'actions') return visibleArtifacts.filter((a) => (a.artifact.suggestedActions?.length ?? 0) > 0);
    return visibleArtifacts;
  }, [filterMode, visibleArtifacts]);
  const filterCounts = useMemo(() => ({
    all: visibleArtifacts.length,
    'open-loops': visibleArtifacts.filter((a) => (a.artifact.openLoops?.length ?? 0) > 0).length,
    decisions: visibleArtifacts.filter((a) => (a.artifact.decisions?.length ?? 0) > 0).length,
    actions: visibleArtifacts.filter((a) => (a.artifact.suggestedActions?.length ?? 0) > 0).length,
    drive: visibleArtifacts.filter((a) => a.artifact.source === 'drive').length,
    gmail: visibleArtifacts.filter((a) => a.artifact.source === 'gmail').length,
  }), [visibleArtifacts]);
  const visibleEntryKeys = useMemo(
    () => new Set(visibleArtifacts.map((item) => item.entryKey)),
    [visibleArtifacts],
  );
  const filteredEntriesForDisplay = useMemo(
    () => (entityFilter ? filteredEntries.filter((entry) => visibleEntryKeys.has(entry.key)) : filteredEntries),
    [entityFilter, filteredEntries, visibleEntryKeys],
  );
  const groupedEntries = useMemo(
    () => groupEntries(filteredEntriesForDisplay, groupingMode),
    [filteredEntriesForDisplay, groupingMode],
  );
  const highlightedArtifactId = searchParams?.get('artifactId') ?? null;
  const potentialConflicts = useMemo(
    () => detectPotentialConflicts(visibleArtifacts),
    [visibleArtifacts],
  );

  const selectionItems = useMemo(
    () => buildSelectionItems(gmailSelections, driveSelections),
    [driveSelections, gmailSelections],
  );

  const summarizedCount = useMemo(
    () => timelineEntries.filter((entry) => entry.status === 'summarized').length,
    [timelineEntries],
  );

  const pendingCount = timelineEntries.length - summarizedCount;
  const isSummarizeCoolingDown = summarizeCooldownUntil !== null;
  const entryKeys = useMemo(
    () => new Set(timelineEntries.map((entry) => entry.key)),
    [timelineEntries],
  );
  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    timelineEntries.forEach((entry) => {
      entry.tags.forEach((tag) => tags.add(tag));
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [timelineEntries]);
  const visibleCountLabel = `${(entityFilter ? visibleArtifacts.length : filteredEntries.length)} shown of ${timelineEntries.length} total`;
  const filtersActive =
    filters.source !== 'all' ||
    filters.status !== 'all' ||
    filters.kind !== 'all' ||
    filters.tag !== 'all' ||
    filters.text.trim().length > 0 ||
    filters.entity.trim().length > 0 ||
    filters.hasOpenLoops ||
    filters.hasRisks ||
    filters.hasDecisions ||
    Boolean(filters.dateFromISO) ||
    Boolean(filters.dateToISO);

  useEffect(() => {
    if (filters.tag !== 'all' && !tagOptions.includes(filters.tag)) {
      setFilters((prev) => ({ ...prev, tag: 'all' }));
    }
  }, [filters.tag, tagOptions]);

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const SUMMARIZE_BATCH_SIZE = 10;

  const handleSummarize = async () => {
    if (selectionItems.length === 0) {
      return;
    }

    setIsSummarizing(true);
    setError(null);
    setErrorRequestId(null);
    setFailedItems([]);

    const batches = chunkArray(
      selectionItems.map((item) => ({ source: item.source, id: item.id })),
      SUMMARIZE_BATCH_SIZE
    );

    const allArtifacts: SummaryArtifact[] = [];
    const allFailed: FailedItem[] = [];

    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        if (batches.length > 1) {
          setSummarizeBatchLabel(`Batch ${i + 1} of ${batches.length}…`);
        }

        const response = await fetch('/api/timeline/summarize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: batch }),
        });

        if (!response.ok) {
          const apiError = await parseApiError(response);
          setErrorRequestId(apiError?.requestId ?? null);
          if (apiError?.code === 'reconnect_required') { setError('reconnect_required'); return; }
          if (apiError?.code === 'drive_not_provisioned') { setError('drive_not_provisioned'); return; }
          if (apiError?.code === 'forbidden_outside_folder') { setError('forbidden_outside_folder'); return; }
          if (apiError?.code === 'too_many_items') { setError('too_many_items'); return; }
          if (apiError?.code === 'rate_limited') { setError('rate_limited'); setSummarizeCooldownUntil(Date.now() + 4000); return; }
          if (apiError?.code === API_ERROR_CODES.upstreamTimeout || apiError?.code === API_ERROR_CODES.upstreamError) { setError(apiError.code); return; }
          if (apiError?.code === API_ERROR_CODES.invalidRequest) { setError('invalid_request'); return; }
          if (apiError?.code === API_ERROR_CODES.providerNotConfigured) { setError('provider_not_configured'); return; }
          if (apiError?.code === API_ERROR_CODES.providerBadOutput) { setError('provider_bad_output'); return; }
          setError('generic');
          return;
        }

        const payload = (await response.json()) as {
          artifacts: SummaryArtifact[];
          failed: FailedItem[];
        };

        if (payload.artifacts?.length) {
          allArtifacts.push(...payload.artifacts);
        }
        if (payload.failed?.length) {
          allFailed.push(...payload.failed);
        }
      }

      if (allArtifacts.length) {
        const next = persistArtifacts(allArtifacts, artifacts);
        setArtifacts(next);
        const driveFileId = allArtifacts.find((artifact) => artifact.driveFileId)?.driveFileId;
        if (driveFileId) {
          setPendingArtifactId(driveFileId);
        }
      }

      if (allFailed.length) {
        setFailedItems(allFailed);
      }
    } catch {
      setError('generic');
      setErrorRequestId(null);
    } finally {
      setIsSummarizing(false);
      setSummarizeBatchLabel(null);
    }
  };

  const handleSyncFromDrive = useCallback(async (options?: { fullSync?: boolean }) => {
    const isFullSync = Boolean(options?.fullSync);
    const sinceCursor = isFullSync ? null : lastSyncISO;
    setIsSyncing(true);
    setSyncError(null);
    setSyncRequestId(null);
    setSyncMessage(null);

    try {
      const syncUrl = sinceCursor
        ? `/api/timeline/artifacts/list?since=${encodeURIComponent(sinceCursor)}`
        : '/api/timeline/artifacts/list';
      const response = await fetch(syncUrl);

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setSyncRequestId(apiError?.requestId ?? null);
        if (apiError?.code === 'reconnect_required') {
          setSyncError('reconnect_required');
          return;
        }
        if (apiError?.code === 'drive_not_provisioned') {
          setSyncError('drive_not_provisioned');
          return;
        }
        if (apiError?.code === 'forbidden_outside_folder') {
          setSyncError('forbidden_outside_folder');
          return;
        }
        if (apiError?.code === 'rate_limited') {
          setSyncError('rate_limited');
          return;
        }
        if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
          setSyncError(apiError.code);
          return;
        }
        setSyncError('generic');
        return;
      }

      const payload = (await response.json()) as {
        artifacts?: SummaryArtifact[];
        files?: Array<{ id?: string; modifiedTime?: string }>;
      };
      const validArtifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts.filter(isSummaryArtifact).map(normalizeArtifact)
        : [];
      const files = Array.isArray(payload.files) ? payload.files : [];

      if (validArtifacts.length === 0) {
        if (Object.keys(artifacts).length === 0) {
          setSyncMessage(
            'No summaries found in Drive. Create a summary from Gmail/Drive selection, then sync.',
          );
        } else {
          setSyncMessage('No new artifacts found.');
        }
        return;
      }

      setArtifacts((prev) => persistArtifacts(validArtifacts, prev));

      const cursorISO = computeNextCursorISO(validArtifacts, files);
      window.localStorage.setItem(LAST_SYNC_KEY, cursorISO);
      setLastSyncISO(cursorISO);
      const syncSuffix = sinceCursor ? ' since last sync' : '';
      setSyncMessage(`Synced ${validArtifacts.length} artifacts from Drive${syncSuffix}`);
    } catch {
      setSyncError('generic');
      setSyncRequestId(null);
    } finally {
      setIsSyncing(false);
    }
  }, [artifacts, lastSyncISO]);

  const handleFullSync = useCallback(() => {
    window.localStorage.removeItem(LAST_SYNC_KEY);
    setLastSyncISO(null);
    void handleSyncFromDrive({ fullSync: true });
  }, [handleSyncFromDrive]);

  useEffect(() => {
    if (!hasHydrated || !autoSyncOnOpen) {
      return;
    }
    void handleSyncFromDrive();
  }, [autoSyncOnOpen, handleSyncFromDrive, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }
    window.localStorage.setItem(GROUPING_KEY, groupingMode);
  }, [groupingMode, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  }, [filters, hasHydrated]);


  const handleClearSelections = useCallback(() => {
    clearStoredSelections();
    setGmailSelections([]);
    setDriveSelections([]);
  }, []);

  const persistSelections = (nextGmail: GmailSelection[], nextDrive: DriveSelection[]) => {
    setGmailSelections(nextGmail);
    setDriveSelections(nextDrive);
    window.localStorage.setItem(GMAIL_KEY, JSON.stringify(nextGmail));
    window.localStorage.setItem(DRIVE_KEY, JSON.stringify(nextDrive));
  };

  const applySelectionItems = useCallback(
    (items: SelectionSetItem[], mode: 'replace' | 'merge') => {
      const nextItems = mode === 'merge' ? mergeSelectionItems(selectionItems, items) : items;
      const { gmail, drive } = selectionItemsToSelections(
        nextItems,
        gmailSelections,
        driveSelections,
      );
      persistSelections(gmail, drive);
    },
    [driveSelections, gmailSelections, selectionItems],
  );

  const scrollToTimelineTop = useCallback(() => {
    requestAnimationFrame(() => {
      const target = timelineTopRef.current;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }, []);

  const applySelectionWithMessage = useCallback(
    (items: SelectionSetItem[], mode: 'replace' | 'merge', name: string) => {
      applySelectionItems(items, mode);
      setAppliedSetMessage(`Applied set “${name}”.`);
      scrollToTimelineTop();
    },
    [applySelectionItems, scrollToTimelineTop],
  );

  const fetchSelectionSets = useCallback(async () => {
    setIsLoadingSets(true);
    setSelectionError(null);
    setSelectionRequestId(null);
    setSelectionMessage(null);

    try {
      const response = await fetch('/api/timeline/selection/list');

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setSelectionRequestId(apiError?.requestId ?? null);
        if (apiError?.code === 'reconnect_required') {
          setSelectionError('reconnect_required');
          return;
        }
        if (apiError?.code === 'drive_not_provisioned') {
          setSelectionError('drive_not_provisioned');
          return;
        }
        if (apiError?.code === 'forbidden_outside_folder') {
          setSelectionError('forbidden_outside_folder');
          return;
        }
        if (apiError?.code === 'rate_limited') {
          setSelectionError('rate_limited');
          return;
        }
        if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
          setSelectionError(apiError.code);
          return;
        }
        setSelectionError('generic');
        return;
      }

      const payload = (await response.json()) as { sets?: SelectionSetSummary[] };
      setSelectionSets(Array.isArray(payload.sets) ? payload.sets : []);
    } catch {
      setSelectionError('generic');
      setSelectionRequestId(null);
    } finally {
      setIsLoadingSets(false);
    }
  }, []);

  const loadIndexStatus = useCallback(async () => {
    setIsIndexLoading(true);
    setIndexError(null);
    setIndexRequestId(null);
    setIndexMessage(null);

    try {
      const response = await fetch('/api/timeline/index/get');

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setIndexRequestId(apiError?.requestId ?? null);
        if (apiError?.code === 'reconnect_required') {
          setIndexError('reconnect_required');
          return;
        }
        if (apiError?.code === 'drive_not_provisioned') {
          setIndexError('drive_not_provisioned');
          return;
        }
        if (apiError?.code === 'forbidden_outside_folder') {
          setIndexError('forbidden_outside_folder');
          return;
        }
        if (apiError?.code === 'rate_limited') {
          setIndexError('rate_limited');
          return;
        }
        if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
          setIndexError(apiError.code);
          return;
        }
        setIndexError('generic');
        return;
      }

      const payload = (await response.json()) as {
        index?: TimelineIndex | null;
        indexStale?: boolean;
      };
      setIndexData(payload.index ?? null);
      setIndexStale(Boolean(payload.indexStale));
    } catch {
      setIndexError('generic');
      setIndexRequestId(null);
    } finally {
      setIsIndexLoading(false);
    }
  }, []);

  const refreshIndex = useCallback(async () => {
    setIsIndexRefreshing(true);
    setIndexError(null);
    setIndexRequestId(null);
    setIndexMessage(null);

    try {
      const response = await fetch('/api/timeline/index/rebuild', { method: 'POST' });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setIndexRequestId(apiError?.requestId ?? null);
        if (apiError?.code === 'reconnect_required') {
          setIndexError('reconnect_required');
          return;
        }
        if (apiError?.code === 'drive_not_provisioned') {
          setIndexError('drive_not_provisioned');
          return;
        }
        if (apiError?.code === 'forbidden_outside_folder') {
          setIndexError('forbidden_outside_folder');
          return;
        }
        if (apiError?.code === 'rate_limited') {
          setIndexError('rate_limited');
          return;
        }
        if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
          setIndexError(apiError.code);
          return;
        }
        setIndexError('generic');
        return;
      }

      const payload = (await response.json()) as { index?: TimelineIndex | null };
      if (payload.index) {
        setIndexData(payload.index);
        setIndexStale(false);
        setIndexMessage('Index refreshed.');
      }
    } catch {
      setIndexError('generic');
      setIndexRequestId(null);
    } finally {
      setIsIndexRefreshing(false);
    }
  }, []);

  const loadSelectionSet = useCallback(
    async (fileId: string, mode?: 'replace' | 'merge') => {
      setIsPreviewLoading(true);
      setPreviewError(null);
      setPreviewRequestId(null);
      setSelectionMessage(null);

      try {
        const response = await fetch(`/api/timeline/selection/read?fileId=${fileId}`);

        if (!response.ok) {
          const apiError = await parseApiError(response);
          setPreviewRequestId(apiError?.requestId ?? null);
          if (apiError?.code === 'reconnect_required') {
            setPreviewError('reconnect_required');
            return;
          }
          if (apiError?.code === 'drive_not_provisioned') {
            setPreviewError('drive_not_provisioned');
            return;
          }
          if (apiError?.code === 'forbidden_outside_folder') {
            setPreviewError('forbidden_outside_folder');
            return;
          }
          if (apiError?.code === 'rate_limited') {
            setPreviewError('rate_limited');
            return;
          }
          if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
            setPreviewError(apiError.code);
            return;
          }
          setPreviewError('generic');
          return;
        }

        const payload = (await response.json()) as { set?: SelectionSet };
        if (!payload.set) {
          setPreviewError('generic');
          return;
        }

        setSelectionPreview(payload.set);
        setSelectionMessage(`Loaded set “${payload.set.name}”`);

        if (mode) {
          applySelectionWithMessage(payload.set.items, mode, payload.set.name);
        }
      } catch {
        setPreviewError('generic');
        setPreviewRequestId(null);
      } finally {
        setIsPreviewLoading(false);
      }
    },
    [applySelectionWithMessage],
  );

  const clearSearchState = useCallback(() => {
    setSearchResults([]);
    setSearchPartial(false);
    setSearchError(null);
    setSearchRequestId(null);
  }, []);

  const runSearch = useCallback(
    async (query: string, type: SearchType) => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }

      const controller = new AbortController();
      searchAbortRef.current = controller;
      setIsSearching(true);
      setSearchError(null);
      setSearchRequestId(null);
      setSearchPartial(false);

      try {
        const response = await fetch(
          `/api/timeline/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`,
          { signal: controller.signal },
        );

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          const apiError = await parseApiError(response);
          setSearchRequestId(apiError?.requestId ?? null);
          if (apiError?.code === 'reconnect_required') {
            setSearchError('reconnect_required');
            return;
          }
          if (apiError?.code === 'drive_not_provisioned') {
            setSearchError('drive_not_provisioned');
            return;
          }
          if (apiError?.code === 'forbidden_outside_folder') {
            setSearchError('forbidden_outside_folder');
            return;
          }
          if (apiError?.code === 'query_too_short') {
            setSearchError('query_too_short');
            return;
          }
          if (apiError?.code === 'rate_limited') {
            setSearchError('rate_limited');
            return;
          }
          if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
            setSearchError(apiError.code);
            return;
          }
          setSearchError('generic');
          return;
        }

        const payload = (await response.json()) as {
          results?: TimelineSearchResult[];
          partial?: boolean;
        };
        setSearchResults(Array.isArray(payload.results) ? payload.results : []);
        setSearchPartial(Boolean(payload.partial));
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setSearchError('generic');
        setSearchRequestId(null);
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    },
    [],
  );

  const handleSearchSubmit = useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault();
      const trimmed = searchQuery.trim();
      if (!trimmed) {
        clearSearchState();
        return;
      }
      if (trimmed.length < 2) {
        setSearchError('query_too_short');
        setSearchRequestId(null);
        setSearchResults([]);
        setSearchPartial(false);
        return;
      }
      if (trimmed.length > 100) {
        setSearchError('query_too_long');
        setSearchRequestId(null);
        setSearchResults([]);
        setSearchPartial(false);
        return;
      }
      void runSearch(trimmed, searchType);
    },
    [clearSearchState, runSearch, searchQuery, searchType],
  );

  const handleSearchRetry = useCallback(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 100) {
      return;
    }
    void runSearch(trimmed, searchType);
  }, [runSearch, searchQuery, searchType]);

  const scrollToEntry = useCallback((key: string) => {
    requestAnimationFrame(() => {
      const element = document.querySelector(`[data-entry-key="${key}"]`);
      if (element instanceof HTMLElement) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }, []);

  const handleJumpToEntry = useCallback(
    (key: string) => {
      setExpandedKeys((prev) => new Set(prev).add(key));
      scrollToEntry(key);
    },
    [scrollToEntry],
  );

  const replaceArtifactParam = useCallback((artifactId: string | null) => {
    const nextParams = new URLSearchParams(searchParams?.toString() ?? '');
    if (artifactId) {
      nextParams.set('artifactId', artifactId);
    } else {
      nextParams.delete('artifactId');
    }
    const query = nextParams.toString();
    router.replace(query ? `/timeline?${query}` : '/timeline');
  }, [router, searchParams]);

  const openArtifactDrawer = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId);
    setIsDrawerOpen(true);
    replaceArtifactParam(artifactId);
  }, [replaceArtifactParam]);

  const closeArtifactDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    setSelectedArtifactId(null);
    replaceArtifactParam(null);
  }, [replaceArtifactParam]);

  const handleDrawerSaved = useCallback((artifactId: string, userAnnotations: SummaryArtifact['userAnnotations'] | null) => {
    setArtifacts((prev) => {
      const next = { ...prev };
      let changed = false;
      Object.entries(prev).forEach(([key, item]) => {
        if (item.driveFileId !== artifactId && item.artifactId !== artifactId) {
          return;
        }
        const updated = { ...item } as SummaryArtifact;
        if (userAnnotations && Object.keys(userAnnotations).length) {
          updated.userAnnotations = userAnnotations;
        } else {
          delete (updated as SummaryArtifact & { userAnnotations?: SummaryArtifact['userAnnotations'] }).userAnnotations;
        }
        next[key] = updated;
        changed = true;
      });
      if (changed && typeof window !== 'undefined') {
        window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(next));
      }
      return changed ? next : prev;
    });
  }, []);

  const jumpToArtifactByDriveId = useCallback(
    (driveFileId: string) => {
      const entry = Object.entries(artifacts).find(([, artifact]) => {
        return artifact.driveFileId === driveFileId;
      });
      if (!entry) {
        return false;
      }
      handleJumpToEntry(entry[0]);
      return true;
    },
    [artifacts, handleJumpToEntry],
  );

  const handleViewSummary = useCallback(
    (result: TimelineSearchResult) => {
      const entryKey =
        result.source && result.sourceId ? artifactKey(result.source, result.sourceId) : null;
      if (entryKey && entryKeys.has(entryKey)) {
        handleJumpToEntry(entryKey);
        return;
      }
      const entry = Object.entries(artifacts).find(([, artifact]) => {
        return artifact.driveFileId === result.driveFileId;
      });
      if (!entry) {
        return;
      }
      handleJumpToEntry(entry[0]);
    },
    [artifacts, entryKeys, handleJumpToEntry],
  );

  const handleAddSummaryResult = useCallback(
    (result: TimelineSearchResult) => {
      if (!result.source || !result.sourceId) {
        return;
      }
      const key = artifactKey(result.source, result.sourceId);
      applySelectionItems(
        [
          {
            source: result.source,
            id: result.sourceId,
            title: result.title,
            dateISO: result.createdAtISO,
          },
        ],
        'merge',
      );
      setAppliedSetMessage(`Added “${result.title}” to selection.`);
      setPendingScrollKey(key);
      scrollToTimelineTop();
    },
    [applySelectionItems, scrollToTimelineTop],
  );

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!pendingScrollKey) {
      return;
    }
    if (entryKeys.has(pendingScrollKey)) {
      handleJumpToEntry(pendingScrollKey);
      setPendingScrollKey(null);
    }
  }, [entryKeys, handleJumpToEntry, pendingScrollKey]);

  useEffect(() => {
    const artifactId = searchParams?.get('artifactId');
    if (!artifactId || jumpedArtifactRef.current === artifactId) {
      return;
    }
    if (Object.keys(artifacts).length === 0) {
      return;
    }
    jumpToArtifactByDriveId(artifactId);
    jumpedArtifactRef.current = artifactId;
  }, [artifacts, jumpToArtifactByDriveId, searchParams]);

  useEffect(() => {
    const artifactId = searchParams?.get('artifactId');
    if (!artifactId) {
      setIsDrawerOpen(false);
      setSelectedArtifactId(null);
      return;
    }
    setSelectedArtifactId(artifactId);
    setIsDrawerOpen(true);
  }, [searchParams]);


  useEffect(() => {
    const rawEntityParam = searchParams?.get('entity') ?? null;
    if (rawEntityParam !== null) {
      const urlEntity = normalizeEntityQueryParam(rawEntityParam);
      if (urlEntity !== entityFilter) {
        setEntityFilter(urlEntity);
        if (typeof window !== 'undefined') {
          if (urlEntity) {
            window.localStorage.setItem(ENTITY_FILTER_KEY, urlEntity);
          } else {
            window.localStorage.removeItem(ENTITY_FILTER_KEY);
          }
        }
      }
    }

    const hasOpenLoops = parseBooleanParam(searchParams?.get('hasOpenLoops') ?? null);
    const hasRisks = parseBooleanParam(searchParams?.get('hasRisks') ?? null);
    const hasDecisions = parseBooleanParam(searchParams?.get('hasDecisions') ?? null);
    const riskSeverityParam = searchParams?.get('riskSeverity');
    const riskSeverity = riskSeverityParam === 'low' || riskSeverityParam === 'medium' || riskSeverityParam === 'high'
      ? riskSeverityParam
      : 'all';

    if (!hasOpenLoops && !hasRisks && !hasDecisions && riskSeverity === 'all') {
      return;
    }

    setFilters((prev) => ({
      ...prev,
      hasOpenLoops: hasOpenLoops || prev.hasOpenLoops,
      hasRisks: hasRisks || prev.hasRisks,
      hasDecisions: hasDecisions || prev.hasDecisions,
      riskSeverity: riskSeverity !== 'all' ? riskSeverity : prev.riskSeverity,
    }));
  }, [entityFilter, searchParams]);

  useEffect(() => {
    if (!pendingArtifactId) {
      return;
    }

    if (searchParams?.get('artifactId') !== pendingArtifactId) {
      router.push(`/timeline?artifactId=${encodeURIComponent(pendingArtifactId)}`);
    }

    if (jumpToArtifactByDriveId(pendingArtifactId)) {
      jumpedArtifactRef.current = pendingArtifactId;
      setPendingArtifactId(null);
      syncAttemptedArtifactRef.current = null;
      syncToastArtifactRef.current = null;
      return;
    }

    if (syncAttemptedArtifactRef.current !== pendingArtifactId) {
      syncAttemptedArtifactRef.current = pendingArtifactId;
      void handleSyncFromDrive();
      return;
    }

    if (!isSyncing && syncToastArtifactRef.current !== pendingArtifactId) {
      setSyncMessage('Summary created. Syncing from Drive…');
      syncToastArtifactRef.current = pendingArtifactId;
    }
  }, [
    handleSyncFromDrive,
    isSyncing,
    jumpToArtifactByDriveId,
    pendingArtifactId,
    router,
    searchParams,
  ]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchAbortRef.current?.abort();
      clearSearchState();
      setIsSearching(false);
      return;
    }

    if (trimmed.length < 2) {
      searchAbortRef.current?.abort();
      setSearchError('query_too_short');
      setSearchRequestId(null);
      setSearchResults([]);
      setSearchPartial(false);
      setIsSearching(false);
      return;
    }

    if (trimmed.length > 100) {
      searchAbortRef.current?.abort();
      setSearchError('query_too_long');
      setSearchRequestId(null);
      setSearchResults([]);
      setSearchPartial(false);
      setIsSearching(false);
      return;
    }

    setSearchError(null);
    setSearchRequestId(null);
    const handle = window.setTimeout(() => {
      void runSearch(trimmed, searchType);
    }, 350);

    return () => {
      window.clearTimeout(handle);
    };
  }, [clearSearchState, runSearch, searchQuery, searchType]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }
    void fetchSelectionSets();
  }, [fetchSelectionSets, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }
    void loadIndexStatus();
  }, [hasHydrated, loadIndexStatus]);


  const updateArtifactActionsLocal = useCallback(
    (
      entryKey: string,
      actionId: string,
      status: 'accepted' | 'dismissed',
      options?: { calendarEvent?: ActionCalendarEvent },
    ) => {
      const artifact = artifacts[entryKey];
      if (!artifact?.suggestedActions?.length) {
        return artifacts;
      }

      const nextArtifact: SummaryArtifact = {
        ...artifact,
        suggestedActions: artifact.suggestedActions.map((action) =>
          action.id === actionId
            ? {
                ...action,
                status,
                ...(options?.calendarEvent ? { calendarEvent: options.calendarEvent } : {}),
                updatedAtISO: new Date().toISOString(),
              }
            : action,
        ),
      };

      const nextArtifacts = { ...artifacts, [entryKey]: nextArtifact };
      window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(nextArtifacts));
      return nextArtifacts;
    },
    [artifacts],
  );

  const handleActionDecision = useCallback(
    async (entryKey: string, artifactDriveFileId: string, actionId: string, decision: 'accept' | 'dismiss') => {
      const optimisticStatus = decision === 'accept' ? 'accepted' : 'dismissed';
      setActionError(null);
      const pendingKey = `${entryKey}:${actionId}`;
      const prevArtifacts = artifacts;
      setActionErrorsByKey((prev) => {
        const next = { ...prev };
        delete next[pendingKey];
        return next;
      });

      setPendingActionKeys((prev) => new Set(prev).add(pendingKey));
      setArtifacts(updateArtifactActionsLocal(entryKey, actionId, optimisticStatus));

      try {
        const response = await fetch('/api/timeline/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ artifactId: artifactDriveFileId, actionId, decision }),
        });

        if (!response.ok) {
          setArtifacts(prevArtifacts);
          window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(prevArtifacts));
          const apiError = await parseApiError(response);
          if (apiError?.code === 'calendar_event_failed') {
            setActionErrorsByKey((prev) => ({
              ...prev,
              [pendingKey]: 'Could not create Google Calendar event. Please try again.',
            }));
          }
          setActionError(apiError?.message ?? 'Unable to update action status.');
          return;
        }

        const payload = (await response.json()) as ActionDecisionResponse;
        if (payload.calendarEvent) {
          setArtifacts(updateArtifactActionsLocal(entryKey, actionId, payload.status, { calendarEvent: payload.calendarEvent }));
        }
      } catch {
        setArtifacts(prevArtifacts);
        window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(prevArtifacts));
        setActionError('Unable to update action status.');
      } finally {
        setPendingActionKeys((prev) => {
          const next = new Set(prev);
          next.delete(pendingKey);
          return next;
        });
      }
    },
    [artifacts, updateArtifactActionsLocal],
  );


  const handleOpenLoopAction = useCallback(
    async (
      entryKey: string,
      artifactDriveFileId: string,
      openLoopIndex: number,
      action: 'close' | 'reopen',
    ) => {
      const pendingKey = `${entryKey}:open-loop:${openLoopIndex}`;
      const prevArtifacts = artifacts;
      setOpenLoopErrorsByKey((prev) => {
        const next = { ...prev };
        delete next[pendingKey];
        return next;
      });
      setPendingOpenLoopKeys((prev) => new Set(prev).add(pendingKey));

      const prevArtifact = artifacts[entryKey];
      if (!prevArtifact?.openLoops) {
        setPendingOpenLoopKeys((prev) => {
          const next = new Set(prev);
          next.delete(pendingKey);
          return next;
        });
        return;
      }

      const nowISO = new Date().toISOString();
      const optimisticOpenLoops = prevArtifact.openLoops.map((loop, idx) => {
        if (idx !== openLoopIndex) return loop;
        if (action === 'close') {
          return { ...loop, status: 'closed' as const, closedAtISO: nowISO };
        }
        return { ...loop, status: 'open' as const, closedAtISO: null, closedReason: null, sourceActionId: null };
      });

      const optimisticArtifact = { ...prevArtifact, openLoops: optimisticOpenLoops };
      const optimisticArtifacts = { ...artifacts, [entryKey]: optimisticArtifact };
      setArtifacts(optimisticArtifacts);
      window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(optimisticArtifacts));

      try {
        const response = await fetch('/api/timeline/open-loops', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ artifactId: artifactDriveFileId, openLoopIndex, action }),
        });

        if (!response.ok) {
          setArtifacts(prevArtifacts);
          window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(prevArtifacts));
          const apiError = await parseApiError(response);
          setOpenLoopErrorsByKey((prev) => ({
            ...prev,
            [pendingKey]: apiError?.message ?? 'Unable to update open loop.',
          }));
          return;
        }

        const payload = (await response.json()) as { updatedOpenLoops?: SummaryArtifact['openLoops'] };
        if (payload.updatedOpenLoops && artifacts[entryKey]) {
          const nextArtifact = { ...(artifacts[entryKey] as SummaryArtifact), openLoops: payload.updatedOpenLoops };
          const nextArtifacts = { ...artifacts, [entryKey]: nextArtifact };
          setArtifacts(nextArtifacts);
          window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(nextArtifacts));
        }
      } catch {
        setArtifacts(prevArtifacts);
        window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(prevArtifacts));
        setOpenLoopErrorsByKey((prev) => ({ ...prev, [pendingKey]: 'Unable to update open loop.' }));
      } finally {
        setPendingOpenLoopKeys((prev) => {
          const next = new Set(prev);
          next.delete(pendingKey);
          return next;
        });
      }
    },
    [artifacts],
  );

  const handleAutoSyncToggle = (checked: boolean) => {
    setAutoSyncOnOpen(checked);
    window.localStorage.setItem(AUTO_SYNC_KEY, checked ? 'true' : 'false');
  };

  const updateFilters = (next: Partial<TimelineFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const handleEntityFilterChange = (next: string | null) => {
    setEntityFilter(next);
  };

  const clearEntityFilter = () => {
    handleEntityFilterChange(null);
  };

  const handleExport = async () => {
    if (visibleArtifacts.length === 0 || isExporting) {
      return;
    }

    setIsExporting(true);
    setExportError(null);
    setExportSuccess(null);
    setExportDriveLink(null);

    try {
      const exportId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `exp_${Date.now()}`;
      const response = await fetch(
        exportFormat === 'pdf' ? '/api/timeline/export/pdf' : '/api/timeline/export/drive',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            exportId,
            artifactIds: visibleArtifacts.map(({ artifact }) => artifact.driveFileId),
            source: {
              viewMode: displayMode,
              ...(selectionSetIdParam ? { selectionSetId: selectionSetIdParam } : {}),
              ...(filters.text ? { query: filters.text } : {}),
              ...(entityFilter ? { entity: entityFilter } : {}),
              ...(fromSelect ? { from: 'select' } : {}),
            },
          }),
        },
      );

      if (response.status === 401) {
        setExportError('Sign in required');
        return;
      }

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setExportError(apiError?.message ?? 'Export failed.');
        return;
      }

      if (exportFormat === 'pdf') {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `timeline-report-${new Date().toISOString().slice(0, 10)}.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(url);
        setExportSuccess('PDF exported successfully.');
      } else {
        const payload = (await response.json()) as { webViewLink?: string };
        setExportSuccess('Drive document exported successfully.');
        setExportDriveLink(payload.webViewLink ?? null);
      }
    } catch {
      setExportError('Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleSaveSelectionSet = async () => {
    if (!saveName.trim()) {
      setSaveError('Enter a name for this saved selection.');
      setSelectionRequestId(null);
      return;
    }

    if (selectionItems.length === 0) {
      setSaveError('Select Gmail or Drive items before saving.');
      setSelectionRequestId(null);
      return;
    }

    setSaveError(null);
    setIsSaving(true);
    setSelectionMessage(null);
    setSelectionRequestId(null);

    try {
      const payload = {
        name: saveName.trim(),
        notes: saveNotes.trim() || undefined,
        items: selectionItems,
        driveFileId: saveToExisting ? selectionPreview?.driveFileId : undefined,
      };

      const response = await fetch('/api/timeline/selection/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setSelectionRequestId(apiError?.requestId ?? null);
        if (apiError?.code === 'reconnect_required') {
          setSelectionError('reconnect_required');
          return;
        }
        if (apiError?.code === 'drive_not_provisioned') {
          setSelectionError('drive_not_provisioned');
          return;
        }
        if (apiError?.code === 'forbidden_outside_folder') {
          setSelectionError('forbidden_outside_folder');
          return;
        }
        if (apiError?.code === 'rate_limited') {
          setSelectionError('rate_limited');
          return;
        }
        if (apiError?.code === 'upstream_timeout' || apiError?.code === 'upstream_error') {
          setSelectionError(apiError.code);
          return;
        }
        if (apiError?.code === 'invalid_request' && apiError.message) {
          setSaveError(apiError.message);
          return;
        }
        setSaveError('Unable to save selection.');
        return;
      }

      const responsePayload = (await response.json()) as { set?: SelectionSet };
      if (responsePayload.set) {
        setSelectionMessage(`Saved set “${responsePayload.set.name}”`);
        setSelectionPreview(responsePayload.set);
        setSaveOpen(false);
        setSaveName('');
        setSaveNotes('');
        setSaveToExisting(false);
        await fetchSelectionSets();
      }
    } catch {
      setSaveError('Unable to save selection.');
      setSelectionRequestId(null);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleSaveOpen = () => {
    setSaveOpen((prev) => {
      const next = !prev;
      if (next) {
        setSaveName((current) => current || selectionPreview?.name || '');
        setSaveNotes((current) => current || selectionPreview?.notes || '');
      }
      return next;
    });
  };

  const lastSyncLabel = lastSyncISO
    ? new Date(lastSyncISO).toLocaleString()
    : 'Not synced yet';

  const indexStatusLabel = indexData ? 'Present' : 'Missing';
  const indexUpdatedLabel = indexData?.updatedAtISO
    ? new Date(indexData.updatedAtISO).toLocaleString()
    : '—';
  const indexCounts = useMemo(() => {
    if (!indexData) {
      return { summaries: 0, selections: 0 };
    }
    const summaries = indexData.stats?.totalSummaries ?? indexData.summaries.length;
    const selections = indexData.stats?.totalSelectionSets ?? indexData.selectionSets.length;
    return { summaries, selections };
  }, [indexData]);

  const previewSummary = useMemo(() => {
    if (!selectionPreview) {
      return null;
    }

    const counts = selectionPreview.items.reduce(
      (acc, item) => {
        acc.total += 1;
        acc[item.source] += 1;
        return acc;
      },
      { total: 0, gmail: 0, drive: 0 },
    );

    return {
      ...counts,
      updatedLabel: selectionPreview.updatedAtISO
        ? new Date(selectionPreview.updatedAtISO).toLocaleString()
        : 'Unknown update time',
    };
  }, [selectionPreview]);

  const reconnectNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Reconnect required. Please <Link href="/connect">connect your Google account</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const provisionNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Provision a Drive folder to store summaries. Visit <Link href="/connect">/connect</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const syncReconnectNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Drive sync needs a reconnect. Please <Link href="/connect">connect your Google account</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const syncProvisionNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Provision a Drive folder to sync summaries. Visit <Link href="/connect">/connect</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const selectionReconnectNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Saved selections need a reconnect. Please <Link href="/connect">connect your Google account</Link>
      .
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const selectionProvisionNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Provision a Drive folder to store saved selections. Visit <Link href="/connect">/connect</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const searchReconnectNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Search needs a reconnect. Please <Link href="/connect">connect your Google account</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const searchProvisionNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Provision a Drive folder to search artifacts. Visit <Link href="/connect">/connect</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const indexReconnectNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Index status needs a reconnect. Please <Link href="/connect">connect your Google account</Link>
      .
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const indexProvisionNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      Provision a Drive folder to store the index. Visit <Link href="/connect">/connect</Link>.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  const outsideFolderNotice = (requestId?: string | null) => (
    <div className={styles.notice}>
      This item lives outside your Timeline app folder. Use the app folder from{' '}
      <Link href="/connect">/connect</Link> to keep artifacts scoped correctly.
      <RequestIdNote requestId={requestId} />
    </div>
  );

  return (
    <section className={styles.page}>
      {status === 'unauthenticated' ? (
        <Card className={styles.noticeCard}>
          <h2>Reconnect to continue</h2>
          <p className={styles.muted}>
            Connect Google to sync artifacts and keep your Timeline up to date.
          </p>
          <Button variant="primary" onClick={() => (window.location.href = '/connect')}>
            Connect Google
          </Button>
        </Card>
      ) : null}
      {status === 'authenticated' && !driveFolderId ? (
        <Card className={styles.noticeCard}>
          <h2>Provision your Drive folder</h2>
          <p className={styles.muted}>
            Timeline needs a Drive folder to store summaries, saved selections, and the index.
          </p>
          <Button variant="secondary" onClick={() => (window.location.href = '/connect')}>
            Provision in /connect
          </Button>
        </Card>
      ) : null}
      {status === 'authenticated' && driveFolderId ? (
        <Card className={styles.noticeCard}>
          <h2>Drive storage</h2>
          <p className={styles.muted}>
            Data stored in Drive folder: <strong>{driveFolderId}</strong>
          </p>
          <div className={styles.noticeActions}>
            <Button
              variant="secondary"
              disabled={!driveFolderLink}
              onClick={() => {
                if (driveFolderLink) {
                  window.open(driveFolderLink, '_blank', 'noreferrer');
                }
              }}
            >
              Open in Drive
            </Button>
            <Button variant="ghost" onClick={() => (window.location.href = '/connect')}>
              Manage in /connect
            </Button>
          </div>
        </Card>
      ) : null}
      <div className={styles.header}>
        <div>
          <p>Unified view of the items you selected from Gmail and Drive.</p>
          <h1>Timeline selection</h1>
          <p className={styles.counts}>
            {timelineEntries.length} selected, {summarizedCount} summarized, {pendingCount} pending
          </p>
          <p className={styles.syncMeta}>Last synced: {lastSyncLabel}</p>
          <p className={styles.syncMeta}>
            Showing summaries from Drive. Pending selections are shown when you add items.
          </p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.actionRow}>
            <Button
              variant="secondary"
              disabled={timelineEntries.length === 0 || isSummarizing || isSummarizeCoolingDown}
              onClick={handleSummarize}
            >
              {isSummarizing
                ? (summarizeBatchLabel ?? 'Summarizing…')
                : 'Generate summaries'}
            </Button>
            <Button variant="ghost" disabled={isSyncing} onClick={() => void handleSyncFromDrive()}>
              {isSyncing ? 'Syncing...' : 'Sync from Drive'}
            </Button>
            <Button variant="ghost" disabled={isSyncing} onClick={handleFullSync}>
              {isSyncing ? 'Syncing...' : 'Full sync'}
            </Button>
          </div>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={autoSyncOnOpen}
              onChange={(event) => handleAutoSyncToggle(event.target.checked)}
            />
            Auto-sync on open
          </label>
        </div>
      </div>

      <RunsPanel fromSelect={fromSelect} selectionSetId={selectionSetIdParam} runId={runIdParam} />

      <Card className={styles.searchPanel}>
        <div className={styles.searchHeader}>
          <div>
            <h2>Search summaries &amp; saved selections</h2>
            <p className={styles.muted}>
              Searches Summary.json and Selection.json artifacts stored inside your app-managed
              Drive folder.
            </p>
          </div>
        </div>
        <form className={styles.searchForm} onSubmit={handleSearchSubmit}>
          <label className={styles.field}>
            <span>Search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search summaries or saved selections"
            />
          </label>
          <div className={styles.searchRow}>
            <label className={styles.field}>
              <span>Type</span>
              <select
                className={styles.searchSelect}
                value={searchType}
                onChange={(event) => setSearchType(event.target.value as SearchType)}
              >
                <option value="all">All</option>
                <option value="summary">Summaries</option>
                <option value="selection">Saved selections</option>
              </select>
            </label>
            <div className={styles.searchButtons}>
              <Button variant="secondary" type="submit" disabled={isSearching}>
                {isSearching ? 'Searching...' : 'Search'}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setSearchQuery('')}
                disabled={!searchQuery}
              >
                Clear
              </Button>
            </div>
          </div>
          {searchError === 'query_too_short' ? (
            <p className={styles.muted}>Enter at least 2 characters to search.</p>
          ) : null}
          {searchError === 'query_too_long' ? (
            <p className={styles.muted}>Search queries must be 100 characters or fewer.</p>
          ) : null}
        </form>

        {searchError === 'reconnect_required' ? searchReconnectNotice(searchRequestId) : null}
        {searchError === 'drive_not_provisioned' ? searchProvisionNotice(searchRequestId) : null}
        {searchError === 'forbidden_outside_folder' ? outsideFolderNotice(searchRequestId) : null}
        {searchError === 'rate_limited' ? (
          <div className={styles.notice}>
            Too many requests — try again in a moment.
            <RequestIdNote requestId={searchRequestId} />
          </div>
        ) : null}
        {searchError === 'upstream_timeout' || searchError === 'upstream_error' ? (
          <div className={styles.notice}>
            Google returned an error — retry.
            <Button variant="ghost" onClick={handleSearchRetry} disabled={isSearching}>
              Retry search
            </Button>
            <RequestIdNote requestId={searchRequestId} />
          </div>
        ) : null}
        {searchError === 'generic' ? (
          <div className={styles.notice}>
            Unable to search right now. Please try again.
            <RequestIdNote requestId={searchRequestId} />
          </div>
        ) : null}
        {searchPartial ? (
          <div className={styles.notice}>
            Showing matches from a subset of files due to the download cap. Refine your search to
            see more results.
          </div>
        ) : null}

        <div className={styles.searchResults}>
          {isSearching ? <p className={styles.muted}>Searching Drive artifacts...</p> : null}
          {!isSearching && searchResults.length === 0 && searchQuery.trim().length >= 2 ? (
            <p className={styles.muted}>No matches yet. Try another keyword.</p>
          ) : null}
          {searchResults.map((result) => {
            const entryKey =
              result.source && result.sourceId
                ? artifactKey(result.source, result.sourceId)
                : null;
            const canAddSelection = Boolean(
              result.kind === 'summary' && entryKey && !entryKeys.has(entryKey),
            );

            return (
              <div key={`${result.kind}-${result.driveFileId}`} className={styles.searchResult}>
                <div className={styles.searchResultHeader}>
                  <Badge tone={result.kind === 'summary' ? 'accent' : 'neutral'}>
                    {result.kind === 'summary' ? 'Summary' : 'Saved Selections'}
                  </Badge>
                  <div>
                    <strong>{result.title}</strong>
                    {result.updatedAtISO ? (
                      <div className={styles.selectionMeta}>
                        Updated {new Date(result.updatedAtISO).toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                </div>
                <p className={styles.searchSnippet}>
                  {result.snippet || 'No preview available for this match.'}
                </p>
                <div className={styles.searchActions}>
                  {result.kind === 'selection' ? (
                    <Button
                      variant="secondary"
                      onClick={() => loadSelectionSet(result.driveFileId, 'replace')}
                      disabled={isPreviewLoading}
                    >
                      {isPreviewLoading ? 'Loading...' : 'Load set'}
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => handleViewSummary(result)}>
                        Jump to item
                      </Button>
                      {canAddSelection ? (
                        <Button
                          variant="secondary"
                          onClick={() => handleAddSummaryResult(result)}
                        >
                          Add to selection
                        </Button>
                      ) : null}
                    </>
                  )}
                  {result.driveWebViewLink ? (
                    <a
                      className={styles.driveLink}
                      href={result.driveWebViewLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Drive
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className={styles.indexPanel}>
        <div className={styles.indexHeader}>
          <div>
            <h2>Index</h2>
            <p className={styles.muted}>
              Metadata index stored in Drive to speed up listing and search.
            </p>
          </div>
          <div className={styles.indexActions}>
            <Button variant="secondary" onClick={refreshIndex} disabled={isIndexRefreshing}>
              {isIndexRefreshing ? 'Refreshing...' : 'Refresh index'}
            </Button>
            <Button variant="ghost" onClick={loadIndexStatus} disabled={isIndexLoading}>
              {isIndexLoading ? 'Loading...' : 'Load status'}
            </Button>
          </div>
        </div>
        <div className={styles.indexGrid}>
          <div>
            <p className={styles.muted}>Status</p>
            <strong>{indexStatusLabel}</strong>
          </div>
          <div>
            <p className={styles.muted}>Last updated</p>
            <strong>{indexUpdatedLabel}</strong>
          </div>
          <div>
            <p className={styles.muted}>Summaries</p>
            <strong>{indexCounts.summaries}</strong>
          </div>
          <div>
            <p className={styles.muted}>Saved Selections</p>
            <strong>{indexCounts.selections}</strong>
          </div>
        </div>
        {indexStale ? (
          <div className={styles.notice}>
            Index may be stale. Refresh to pull the latest Drive metadata.
          </div>
        ) : null}
        {indexError === 'reconnect_required' ? indexReconnectNotice(indexRequestId) : null}
        {indexError === 'drive_not_provisioned' ? indexProvisionNotice(indexRequestId) : null}
        {indexError === 'forbidden_outside_folder' ? outsideFolderNotice(indexRequestId) : null}
        {indexError === 'rate_limited' ? (
          <div className={styles.notice}>
            Too many requests — try again in a moment.
            <RequestIdNote requestId={indexRequestId} />
          </div>
        ) : null}
        {indexError === 'upstream_timeout' || indexError === 'upstream_error' ? (
          <div className={styles.notice}>
            Google returned an error — retry.
            <RequestIdNote requestId={indexRequestId} />
          </div>
        ) : null}
        {indexError === 'generic' ? (
          <div className={styles.notice}>
            Unable to load the index right now.
            <RequestIdNote requestId={indexRequestId} />
          </div>
        ) : null}
        {indexMessage ? <div className={styles.noticeSuccess}>{indexMessage}</div> : null}
      </Card>


      {selectionMigrationWarning ? (
        <div className={styles.notice}>Your saved selection format changed after an update. Please reselect files.</div>
      ) : null}
      {error === 'reconnect_required' ? reconnectNotice(errorRequestId) : null}
      {error === 'drive_not_provisioned' ? provisionNotice(errorRequestId) : null}
      {error === 'forbidden_outside_folder' ? outsideFolderNotice(errorRequestId) : null}
      {error === 'rate_limited' ? (
        <div className={styles.notice}>
          Too many requests — try again in a moment.
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'upstream_timeout' || error === 'upstream_error' ? (
        <div className={styles.notice}>
          Google returned an error — retry.
          <Button variant="ghost" onClick={handleSummarize} disabled={isSummarizing}>
            {isSummarizing
              ? (summarizeBatchLabel ?? 'Summarizing…')
              : 'Retry summaries'}
          </Button>
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'invalid_request' ? (
        <div className={styles.notice}>
          We could not process your selection (invalid_request).
          <Button variant="ghost" onClick={handleClearSelections}>Clear selections</Button>
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'provider_not_configured' ? (
        <div className={styles.notice}>
          Summarization provider is not configured (provider_not_configured).
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'provider_bad_output' ? (
        <div className={styles.notice}>
          Provider returned invalid output (provider_bad_output). Retry.
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'too_many_items' ? (
        <div className={styles.notice}>
          Select up to 10 items before generating summaries.
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {error === 'generic' ? (
        <div className={styles.notice}>
          Unable to generate summaries. Please try again.
          <RequestIdNote requestId={errorRequestId} />
        </div>
      ) : null}
      {failedItems.length > 0 ? (
        <details className={styles.failedPanel}>
          <summary className={styles.failedSummary}>
            {failedItems.length} item{failedItems.length !== 1 ? 's' : ''} could not be summarised — click to see details
          </summary>
          <div className={styles.failedList}>
            {failedItems.map((item) => {
              const { reason, hint } = getFailedItemLabel(item);
              return (
                <div key={`${item.source}-${item.id}`} className={styles.failedItem}>
                  <span className={styles.failedReason}>{reason}</span>
                  <span className={styles.failedHint}>{hint}</span>
                  <span className={styles.failedId}>{item.source}:{item.id}</span>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
      {syncError === 'reconnect_required' ? syncReconnectNotice(syncRequestId) : null}
      {syncError === 'drive_not_provisioned' ? syncProvisionNotice(syncRequestId) : null}
      {syncError === 'forbidden_outside_folder' ? outsideFolderNotice(syncRequestId) : null}
      {syncError === 'rate_limited' ? (
        <div className={styles.notice}>
          Too many requests — try again in a moment.
          <RequestIdNote requestId={syncRequestId} />
        </div>
      ) : null}
      {syncError === 'upstream_timeout' || syncError === 'upstream_error' ? (
        <div className={styles.notice}>
          Google returned an error — retry.
          <Button variant="ghost" onClick={() => void handleSyncFromDrive()} disabled={isSyncing}>
            Retry sync
          </Button>
          <RequestIdNote requestId={syncRequestId} />
        </div>
      ) : null}
      {syncError === 'generic' ? (
        <div className={styles.notice}>
          Unable to sync from Drive. Please try again.
          <RequestIdNote requestId={syncRequestId} />
        </div>
      ) : null}
      {syncMessage ? <div className={styles.noticeSuccess}>{syncMessage}</div> : null}
      {actionError ? <div className={styles.notice}>{actionError}</div> : null}

      <Card className={styles.selectionPanel}>
        <div className={styles.selectionHeader}>
          <div>
            <h2>Saved Selections</h2>
            <p className={styles.muted}>
              Save the current selection to Drive, or load a saved set from another device.
            </p>
          </div>
          <div className={styles.selectionActions}>
            <Button variant="secondary" onClick={toggleSaveOpen}>
              {saveOpen ? 'Close save form' : 'Save selection'}
            </Button>
            <Button variant="ghost" onClick={fetchSelectionSets} disabled={isLoadingSets}>
              {isLoadingSets ? 'Refreshing...' : 'Refresh list'}
            </Button>
          </div>
        </div>

        {selectionError === 'reconnect_required'
          ? selectionReconnectNotice(selectionRequestId)
          : null}
        {selectionError === 'drive_not_provisioned'
          ? selectionProvisionNotice(selectionRequestId)
          : null}
        {selectionError === 'forbidden_outside_folder'
          ? outsideFolderNotice(selectionRequestId)
          : null}
        {selectionError === 'rate_limited' ? (
          <div className={styles.notice}>
            Too many requests — try again in a moment.
            <RequestIdNote requestId={selectionRequestId} />
          </div>
        ) : null}
        {selectionError === 'upstream_timeout' || selectionError === 'upstream_error' ? (
          <div className={styles.notice}>
            Google returned an error — retry.
            <Button variant="ghost" onClick={fetchSelectionSets} disabled={isLoadingSets}>
              Retry list
            </Button>
            <RequestIdNote requestId={selectionRequestId} />
          </div>
        ) : null}
        {selectionError === 'generic' ? (
          <div className={styles.notice}>
            Unable to load saved selections. Please try again.
            <RequestIdNote requestId={selectionRequestId} />
          </div>
        ) : null}
        {selectionMessage ? <div className={styles.noticeSuccess}>{selectionMessage}</div> : null}

        {saveOpen ? (
          <div className={styles.selectionForm}>
            <label className={styles.field}>
              <span>Selection name</span>
              <input
                type="text"
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                placeholder="e.g. Q2 Launch Research"
              />
            </label>
            <label className={styles.field}>
              <span>Notes (optional)</span>
              <textarea
                value={saveNotes}
                onChange={(event) => setSaveNotes(event.target.value)}
                placeholder="Why this selection matters"
                rows={3}
              />
            </label>
            {selectionPreview?.driveFileId ? (
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={saveToExisting}
                  onChange={(event) => setSaveToExisting(event.target.checked)}
                />
                Update the loaded set in Drive
              </label>
            ) : null}
            {saveError ? (
              <div className={styles.notice}>
                {saveError}
                <RequestIdNote requestId={selectionRequestId} />
              </div>
            ) : null}
            <div className={styles.formActions}>
              <Button
                variant="primary"
                onClick={handleSaveSelectionSet}
                disabled={isSaving || selectionItems.length === 0}
              >
                {isSaving ? 'Saving...' : 'Save to Drive'}
              </Button>
              <span className={styles.muted}>{selectionItems.length} items in selection</span>
            </div>
          </div>
        ) : null}

        <div className={styles.selectionList}>
          {isLoadingSets ? <p className={styles.muted}>Loading saved selections...</p> : null}
          {!isLoadingSets && selectionSets.length === 0 ? (
            <p className={styles.muted}>No saved selections yet.</p>
          ) : null}
          {selectionSets.map((set) => (
            <div key={set.driveFileId} className={styles.selectionRow}>
              <div>
                <strong>{set.name}</strong>
                <div className={styles.selectionMeta}>
                  Updated {new Date(set.updatedAtISO).toLocaleString()}
                </div>
              </div>
              <div className={styles.selectionButtons}>
                <Button
                  variant="ghost"
                  onClick={() => loadSelectionSet(set.driveFileId)}
                  disabled={isPreviewLoading}
                >
                  {isPreviewLoading ? 'Loading...' : 'Load'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => loadSelectionSet(set.driveFileId, 'replace')}
                  disabled={isPreviewLoading}
                >
                  Replace selection
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => loadSelectionSet(set.driveFileId, 'merge')}
                  disabled={isPreviewLoading}
                >
                  Merge into selection
                </Button>
                {set.driveWebViewLink ? (
                  <a
                    className={styles.driveLink}
                    href={set.driveWebViewLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Drive
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {previewError === 'reconnect_required'
          ? selectionReconnectNotice(previewRequestId)
          : null}
        {previewError === 'drive_not_provisioned'
          ? selectionProvisionNotice(previewRequestId)
          : null}
        {previewError === 'forbidden_outside_folder'
          ? outsideFolderNotice(previewRequestId)
          : null}
        {previewError === 'rate_limited' ? (
          <div className={styles.notice}>
            Too many requests — try again in a moment.
            <RequestIdNote requestId={previewRequestId} />
          </div>
        ) : null}
        {previewError === 'upstream_timeout' || previewError === 'upstream_error' ? (
          <div className={styles.notice}>
            Google returned an error — retry.
            <RequestIdNote requestId={previewRequestId} />
          </div>
        ) : null}
        {previewError === 'generic' ? (
          <div className={styles.notice}>
            Unable to load that saved selection.
            <RequestIdNote requestId={previewRequestId} />
          </div>
        ) : null}

        {selectionPreview && previewSummary ? (
          <div className={styles.selectionPreview}>
            <div>
              <h3>{selectionPreview.name}</h3>
              <p className={styles.muted}>
                {previewSummary.total} items ({previewSummary.gmail} Gmail, {previewSummary.drive}{' '}
                Drive)
              </p>
              <p className={styles.muted}>Updated {previewSummary.updatedLabel}</p>
              {selectionPreview.notes ? <p>{selectionPreview.notes}</p> : null}
            </div>
            <div className={styles.selectionButtons}>
              <Button
                variant="secondary"
                onClick={() =>
                  applySelectionWithMessage(
                    selectionPreview.items,
                    'replace',
                    selectionPreview.name,
                  )
                }
              >
                Replace selection
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  applySelectionWithMessage(selectionPreview.items, 'merge', selectionPreview.name)
                }
              >
                Merge into selection
              </Button>
              {selectionPreview.driveWebViewLink ? (
                <a
                  className={styles.driveLink}
                  href={selectionPreview.driveWebViewLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Drive
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      <div ref={timelineTopRef} className={styles.timelineSection}>
        {timelineEntries.length > 0 ? (
          <Card className={styles.toolbar}>
            <div className={styles.toolbarHeader}>
              <h2>Timeline view</h2>
              <span className={styles.toolbarCount}>{visibleCountLabel}</span>
            </div>
            <div className={styles.toolbarRow}>
              <div className={styles.segmentedControl} role="group" aria-label="View mode">
                <Button
                  variant="ghost"
                  className={displayMode === 'summaries' ? styles.segmentedActive : undefined}
                  onClick={() => setDisplayMode('summaries')}
                >
                  Summaries
                </Button>
                <Button
                  variant="ghost"
                  className={displayMode === 'timeline' ? styles.segmentedActive : undefined}
                  onClick={() => setDisplayMode('timeline')}
                >
                  Timeline
                </Button>
              </div>
              <div className={styles.exportControls}>
                <label className={styles.field}>
                  <span>Export</span>
                  <select
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                    disabled={visibleArtifacts.length === 0 || isExporting}
                  >
                    <option value="pdf">Export as PDF</option>
                    <option value="drive">Export to Drive Doc</option>
                  </select>
                </label>
                <Button
                  variant="secondary"
                  onClick={handleExport}
                  disabled={visibleArtifacts.length === 0 || isExporting}
                >
                  {isExporting ? 'Exporting…' : 'Export'}
                </Button>
              </div>
              <EntityFilter
                entities={indexedEntities}
                counts={entityCounts}
                value={entityFilter}
                onChange={handleEntityFilterChange}
              />
              {displayMode === 'summaries' ? (
                <div className={styles.segmentedControl} role="group" aria-label="Grouping">
                  <Button
                    variant="ghost"
                    className={groupingMode === 'day' ? styles.segmentedActive : undefined}
                    onClick={() => setGroupingMode('day')}
                  >
                    Day
                  </Button>
                  <Button
                    variant="ghost"
                    className={groupingMode === 'week' ? styles.segmentedActive : undefined}
                    onClick={() => setGroupingMode('week')}
                  >
                    Week
                  </Button>
                  <Button
                    variant="ghost"
                    className={groupingMode === 'month' ? styles.segmentedActive : undefined}
                    onClick={() => setGroupingMode('month')}
                  >
                    Month
                  </Button>
                </div>
              ) : null}
              <div className={styles.toolbarFilters}>
                <label className={styles.field}>
                  <span>Source</span>
                  <select
                    value={filters.source}
                    onChange={(event) =>
                      updateFilters({ source: event.target.value as TimelineFilters['source'] })
                    }
                  >
                    <option value="all">All</option>
                    <option value="gmail">Gmail</option>
                    <option value="drive">Drive</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Status</span>
                  <select
                    value={filters.status}
                    onChange={(event) =>
                      updateFilters({ status: event.target.value as TimelineFilters['status'] })
                    }
                  >
                    <option value="all">All</option>
                    <option value="summarized">Summarized</option>
                    <option value="pending">Pending</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Kind</span>
                  <select
                    value={filters.kind}
                    onChange={(event) =>
                      updateFilters({ kind: event.target.value as TimelineFilters['kind'] })
                    }
                  >
                    <option value="all">All</option>
                    <option value="summary">Summaries</option>
                    <option value="selection">Selection-only</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Tag</span>
                  <select
                    value={filters.tag}
                    onChange={(event) => updateFilters({ tag: event.target.value })}
                  >
                    <option value="all">All</option>
                    {tagOptions.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Text</span>
                  <input
                    type="text"
                    value={filters.text}
                    onChange={(event) => updateFilters({ text: event.target.value })}
                    placeholder="Filter by title or preview"
                  />
                </label>
                <label className={styles.field}>
                  <span>Date from</span>
                  <input
                    type="date"
                    value={(filters.dateFromISO ?? '').slice(0, 10)}
                    onChange={(event) =>
                      updateFilters({
                        dateFromISO: event.target.value
                          ? new Date(`${event.target.value}T00:00:00.000Z`).toISOString()
                          : '',
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  <span>Date to</span>
                  <input
                    type="date"
                    value={(filters.dateToISO ?? '').slice(0, 10)}
                    onChange={(event) =>
                      updateFilters({
                        dateToISO: event.target.value
                          ? new Date(`${event.target.value}T23:59:59.999Z`).toISOString()
                          : '',
                      })
                    }
                  />
                </label>
              </div>
            </div>
            <div className={styles.toolbarRow}>
              <span className={styles.muted}>{visibleCountLabel}</span>
              <Button variant="ghost" onClick={clearFilters} disabled={!filtersActive}>
                Clear all filters
              </Button>
            </div>
          </Card>
        ) : null}

        {appliedSetMessage ? <div className={styles.noticeSuccess}>{appliedSetMessage}</div> : null}
        {exportSuccess ? <div className={styles.noticeSuccess}>{exportSuccess}</div> : null}
        {exportError ? <div className={styles.notice}>{exportError}</div> : null}
        {exportDriveLink ? (
          <div className={styles.noticeSuccess}>
            <a href={exportDriveLink} target="_blank" rel="noreferrer" className={styles.driveLink}>
              Open in Drive
            </a>
          </div>
        ) : null}


        <TimelineQuality artifacts={visibleArtifacts} onDateApplied={() => handleSyncFromDrive({ fullSync: true })} />

        <MissingInfo artifacts={visibleArtifacts} onApplied={() => handleSyncFromDrive({ fullSync: true })} />

        <PotentialConflicts
          conflicts={potentialConflicts}
          highlightedArtifactId={highlightedArtifactId}
        />

        <RecentExports
          viewMode={displayMode}
          selectionSetId={selectionSetIdParam}
          from={fromSelect ? 'select' : undefined}
          query={filters.text || undefined}
        />

        {timelineEntries.length === 0 ? (
          <Card className={styles.emptyState}>
            <h2>No items selected yet</h2>
            <p>Pick Gmail and Drive items to create your first Timeline selection.</p>
          </Card>
        ) : filteredEntriesForDisplay.length === 0 ? (
          <Card className={styles.emptyState}>
            <h2>No items match your filters</h2>
            <p>Try adjusting or clearing your filters to see more.</p>
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          </Card>
        ) : entityFilter && visibleArtifacts.length === 0 ? (
          <Card className={styles.emptyState}>
            <h2>No artifacts match entity ‘{entityFilter}’ in the current view.</h2>
            <Button variant="secondary" onClick={clearEntityFilter}>
              Clear entity filter
            </Button>
          </Card>
        ) : displayMode === 'timeline' ? (
          <div className={styles.twoCol}>
            <nav className={styles.filterNav} aria-label="Filter timeline">
              <p className={styles.filterNavLabel}>View</p>
              {(
                [
                  { mode: 'all', label: 'All entries' },
                  { mode: 'open-loops', label: 'Open loops' },
                  { mode: 'decisions', label: 'Decisions' },
                  { mode: 'actions', label: 'Actions' },
                ] as Array<{ mode: FilterMode; label: string }>
              ).map(({ mode, label }) => (
                <button
                  key={mode}
                  className={`${styles.filterNavItem} ${filterMode === mode ? styles.filterNavItemActive : ''}`}
                  onClick={() => setFilterMode(mode)}
                >
                  {label}
                  {filterCounts[mode] > 0 ? (
                    <span className={styles.filterNavCount}>{filterCounts[mode]}</span>
                  ) : null}
                </button>
              ))}
              <p className={styles.filterNavLabel}>Source</p>
              {(
                [
                  { mode: 'drive', label: 'Drive only' },
                  { mode: 'gmail', label: 'Gmail only' },
                ] as Array<{ mode: FilterMode; label: string }>
              ).map(({ mode, label }) => (
                <button
                  key={mode}
                  className={`${styles.filterNavItem} ${filterMode === mode ? styles.filterNavItemActive : ''}`}
                  onClick={() => setFilterMode(mode)}
                >
                  {label}
                  {filterCounts[mode] > 0 ? (
                    <span className={styles.filterNavCount}>{filterCounts[mode]}</span>
                  ) : null}
                </button>
              ))}
            </nav>
            <div className={styles.filterContent}>
              <TimelineView
                artifacts={filteredArtifacts}
                highlightedArtifactId={highlightedArtifactId}
                onSelectArtifact={openArtifactDrawer}
              />
            </div>
          </div>
        ) : (
          <div className={styles.groupList}>
            {groupedEntries.map((group) => (
              <div key={group.key} className={styles.group}>
                <div className={styles.groupHeader}>{group.label}</div>
                <div className={styles.groupEntries}>
                  {group.entries.map((entry) => {
                    const isExpanded = expandedKeys.has(entry.key);
                    const summaryText = entry.summary ?? '';
                    const summaryExcerpt =
                      summaryText.length > 180 ? `${summaryText.slice(0, 180)}…` : summaryText;
                    const meta = entry.metadata;
                    const dateLabel = entry.dateISO
                      ? new Date(entry.dateISO).toLocaleString()
                      : '—';

                    return (
                      <Card
                        key={entry.key}
                        className={`${styles.item} ${styles.clickableItem}`.trim()}
                        data-entry-key={entry.key}
                        tabIndex={0}
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('a,button,input,textarea,select,summary')) {
                            return;
                          }
                          const id = artifacts[entry.key]?.driveFileId;
                          if (id) {
                            openArtifactDrawer(id);
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.key === 'Enter' || event.key === ' ') && artifacts[entry.key]?.driveFileId) {
                            event.preventDefault();
                            openArtifactDrawer(artifacts[entry.key]?.driveFileId ?? '');
                          }
                        }}
                      >
                        <div className={styles.itemContent}>
                          <div className={styles.itemHeader}>
                            <div>
                              <h3>{entry.title}</h3>
                              <div className={styles.badgeRow}>
                                <Badge tone="neutral">
                                  {entry.source === 'gmail' ? 'Gmail' : 'Drive'}
                                </Badge>
                                <Badge tone={entry.status === 'summarized' ? 'success' : 'warning'}>
                                  {entry.status === 'summarized' ? 'Summarized' : 'Pending'}
                                </Badge>
                              </div>
                            </div>
                            <span className={styles.timestamp}>{dateLabel}</span>
                          </div>
                          {(meta?.from || meta?.subject || meta?.mimeType || meta?.modifiedTime) && (
                            <div className={styles.metadata}>
                              {meta?.from ? (
                                <div className={styles.metaRow}>
                                  <span className={styles.metaLabel}>From</span>
                                  <span>{meta.from}</span>
                                </div>
                              ) : null}
                              {meta?.subject ? (
                                <div className={styles.metaRow}>
                                  <span className={styles.metaLabel}>Subject</span>
                                  <span>{meta.subject}</span>
                                </div>
                              ) : null}
                              {meta?.mimeType ? (
                                <div className={styles.metaRow}>
                                  <span className={styles.metaLabel}>MIME type</span>
                                  <span>{meta.mimeType}</span>
                                </div>
                              ) : null}
                              {meta?.modifiedTime ? (
                                <div className={styles.metaRow}>
                                  <span className={styles.metaLabel}>Modified</span>
                                  <span>{meta.modifiedTime}</span>
                                </div>
                              ) : null}
                            </div>
                          )}
                          {entry.status === 'summarized' ? (
                            <div className={styles.summaryBlock}>
                              <p className={styles.summaryText}>
                                {isExpanded ? summaryText : summaryExcerpt}
                              </p>
                              {isExpanded && entry.highlights?.length ? (
                                <ul className={styles.highlights}>
                                  {entry.highlights.map((highlight, index) => (
                                    <li key={`${entry.key}-highlight-${index}`}>{highlight}</li>
                                  ))}
                                </ul>
                              ) : null}
                              {entry.sourcePreview ? (
                                <details className={styles.preview}>
                                  <summary>Content preview</summary>
                                  <div className={styles.previewContent}>
                                    <p>{entry.sourcePreview}</p>
                                    {entry.sourceMetadata?.driveWebViewLink ? (
                                      <a
                                        className={styles.driveLink}
                                        href={entry.sourceMetadata.driveWebViewLink}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Open source file
                                      </a>
                                    ) : null}
                                  </div>
                                </details>
                              ) : null}

                              {entry.entities?.length || entry.decisions?.length || entry.openLoops?.length || entry.risks?.length ? (
                                <details className={styles.preview}>
                                  <summary>Structured</summary>
                                  <div className={styles.previewContent}>
                                    {entry.entities?.length ? <p><strong>Entities:</strong> {entry.entities.map((entity) => `${entity.name}${entity.type ? ` (${entity.type})` : ''}`).join(', ')}</p> : null}
                                    {entry.decisions?.length ? (
                                      <>
                                        <p><strong>Decisions</strong></p>
                                        <ul className={styles.highlights}>{entry.decisions.slice(0, isExpanded ? undefined : 3).map((item, idx) => <li key={`${entry.key}-decision-${idx}`}>{item.text}</li>)}</ul>
                                      </>
                                    ) : null}
                                    {entry.openLoops?.length ? (
                                      <>
                                        <p><strong>Open loops</strong></p>
                                        <ul className={styles.highlights}>
                                          {entry.openLoops.slice(0, isExpanded ? undefined : 3).map((item, idx) => {
                                            const loopKey = `${entry.key}:open-loop:${idx}`;
                                            const pending = pendingOpenLoopKeys.has(loopKey);
                                            const isClosed = (item.status ?? 'open') === 'closed';
                                            const canMutate = Boolean(artifacts[entry.key]?.driveFileId);
                                            return (
                                              <li key={`${entry.key}-openloop-${idx}`}>
                                                <span>
                                                  {item.text} <em>({isClosed ? 'closed' : 'open'})</em>
                                                  {item.closedReason ? ` — ${item.closedReason}` : ''}
                                                </span>{' '}
                                                <Button
                                                  variant="ghost"
                                                  disabled={pending || !canMutate}
                                                  onClick={() =>
                                                    artifacts[entry.key]?.driveFileId &&
                                                    void handleOpenLoopAction(entry.key, artifacts[entry.key]?.driveFileId ?? '', idx, isClosed ? 'reopen' : 'close')
                                                  }
                                                >
                                                  {isClosed ? 'Reopen' : 'Mark closed'}
                                                </Button>
                                                {openLoopErrorsByKey[loopKey] ? (
                                                  <span className={styles.actionInlineError}> {openLoopErrorsByKey[loopKey]}</span>
                                                ) : null}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </>
                                    ) : null}
                                    {entry.risks?.length ? (
                                      <>
                                        <p><strong>Risks</strong></p>
                                        <ul className={styles.highlights}>{entry.risks.slice(0, isExpanded ? undefined : 3).map((item, idx) => <li key={`${entry.key}-risk-${idx}`}>{item.text}</li>)}</ul>
                                      </>
                                    ) : null}
                                  </div>
                                </details>
                              ) : null}

                              {entry.suggestedActions?.length ? (
                                <div className={styles.actionsBlock}>
                                  <h4>Actions</h4>
                                  {(() => {
                                    const proposed = entry.suggestedActions.filter((action) => (action.status ?? 'proposed') === 'proposed');
                                    const resolved = entry.suggestedActions.filter((action) => (action.status ?? 'proposed') !== 'proposed');
                                    return (
                                      <>
                                        <ul className={styles.actionsList}>
                                          {proposed.map((action) => {
                                            const key = `${entry.key}:${action.id ?? action.text}`;
                                            const pending = pendingActionKeys.has(key);
                                            return (
                                              <li key={key} className={styles.actionItem}>
                                                <div>
                                                  <strong>{action.type}</strong>: {action.text}
                                                  {actionErrorsByKey[key] ? (
                                                    <p className={styles.actionInlineError}>{actionErrorsByKey[key]}</p>
                                                  ) : null}
                                                </div>
                                                <div className={styles.actionButtons}>
                                                  <Button
                                                    variant="secondary"
                                                    disabled={pending || !action.id || !artifacts[entry.key]?.driveFileId}
                                                    onClick={() =>
                                                      action.id &&
                                                      artifacts[entry.key]?.driveFileId &&
                                                      void handleActionDecision(entry.key, artifacts[entry.key]?.driveFileId ?? '', action.id, 'accept')
                                                    }
                                                  >
                                                    Accept
                                                  </Button>
                                                  <Button
                                                    variant="ghost"
                                                    disabled={pending || !action.id || !artifacts[entry.key]?.driveFileId}
                                                    onClick={() =>
                                                      action.id &&
                                                      artifacts[entry.key]?.driveFileId &&
                                                      void handleActionDecision(entry.key, artifacts[entry.key]?.driveFileId ?? '', action.id, 'dismiss')
                                                    }
                                                  >
                                                    Dismiss
                                                  </Button>
                                                </div>
                                              </li>
                                            );
                                          })}
                                        </ul>
                                        {resolved.length ? (
                                          <details>
                                            <summary>Accepted / dismissed</summary>
                                            <ul className={styles.actionsList}>
                                              {resolved.map((action) => (
                                                <li key={`${entry.key}:${action.id ?? action.text}`} className={styles.actionItemMuted}>
                                                  <span>
                                                    <strong>{action.type}</strong>: {action.text}
                                                    {action.calendarEvent ? (
                                                      <span className={styles.calendarEventMeta}>
                                                        <a href={action.calendarEvent.htmlLink} target="_blank" rel="noreferrer">
                                                          View event
                                                        </a>
                                                        <span>
                                                          {action.calendarEvent.startISO} → {action.calendarEvent.endISO}
                                                        </span>
                                                      </span>
                                                    ) : null}
                                                  </span>
                                                  <span>{action.status}</span>
                                                </li>
                                              ))}
                                            </ul>
                                          </details>
                                        ) : null}
                                      </>
                                    );
                                  })()}
                                </div>
                              ) : null}

                              <div className={styles.summaryActions}>
                                <Button variant="ghost" onClick={() => toggleExpanded(entry.key)}>
                                  {isExpanded ? 'Collapse' : 'Expand'}
                                </Button>
                                {entry.driveWebViewLink ? (
                                  <a
                                    className={styles.driveLink}
                                    href={entry.driveWebViewLink}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open in Drive
                                  </a>
                                ) : null}
                              </div>
                            </div>
                          ) : (
                            <div className={styles.pendingActions}>
                              {entry.driveWebViewLink ? (
                                <a
                                  className={styles.driveLink}
                                  href={entry.driveWebViewLink}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open in Drive
                                </a>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ArtifactDetailsDrawer
        isOpen={isDrawerOpen}
        artifactId={selectedArtifactId}
        artifact={visibleArtifacts.find(({ artifact }) => artifact.driveFileId === selectedArtifactId || artifact.artifactId === selectedArtifactId) ?? null}
        onClose={closeArtifactDrawer}
        onSaved={handleDrawerSaved}
      />
    </section>
  );
}
