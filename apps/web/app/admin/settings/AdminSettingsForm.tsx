'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { parseApiError } from '../../lib/apiErrors';
import type { AdminSettings } from '../../lib/adminSettings';
import { DEFAULT_ADMIN_SETTINGS, normalizeAdminSettings } from '../../lib/adminSettings';
import styles from './page.module.css';

type Status = 'loading' | 'ready' | 'error' | 'reconnect';

type TestResult = {
  provider: string;
  model: string;
  summary: string;
  highlights: string[];
  timings: { ms: number };
};

type BackfillStatusItem = {
  fileId: string;
  title: string;
  before: string | null;
  after: string | null;
  status: 'updated' | 'skipped' | 'no_date';
};

type BackfillResult = {
  dryRun: boolean;
  limit: number;
  scanned: number;
  updated: number;
  skippedAlreadyHasDate: number;
  noDateFound: number;
  items: BackfillStatusItem[];
};

const defaultSettings: AdminSettings = {
  ...DEFAULT_ADMIN_SETTINGS,
  updatedAtISO: new Date(0).toISOString(),
};

const toPositiveInteger = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
};

const toFloat = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export default function AdminSettingsForm() {
  const [status, setStatus] = useState<Status>('loading');
  const [settings, setSettings] = useState<AdminSettings>(defaultSettings);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [enableBackfill, setEnableBackfill] = useState(false);
  const [backfillDryRun, setBackfillDryRun] = useState(true);
  const [backfillLimit, setBackfillLimit] = useState<10 | 25>(10);
  const [isRunningBackfill, setIsRunningBackfill] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!settings.routing.default.provider) {
      errors.push('Default provider is required.');
    }
    if (!settings.routing.default.model.trim()) {
      errors.push('Default model is required.');
    }
    for (const task of ['chat', 'summarize'] as const) {
      if (!(settings.tasks[task].temperature >= 0 && settings.tasks[task].temperature <= 2)) {
        errors.push(`${task} temperature must be between 0 and 2.`);
      }
      if (!Number.isInteger(settings.tasks[task].maxContextItems) || settings.tasks[task].maxContextItems <= 0) {
        errors.push(`${task} max context items must be a positive integer.`);
      }
      if (
        settings.tasks[task].maxOutputTokens !== undefined &&
        (!Number.isInteger(settings.tasks[task].maxOutputTokens) || settings.tasks[task].maxOutputTokens <= 0)
      ) {
        errors.push(`${task} max output tokens must be a positive integer when provided.`);
      }
    }
    return errors;
  }, [settings]);

  const loadSettings = useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);
    try {
      const response = await fetch('/api/admin/settings');
      if (response.status === 401) {
        setStatus('reconnect');
        return;
      }
      if (!response.ok) {
        const apiError = await parseApiError(response);
        setStatus('error');
        setErrorMessage(apiError?.message ?? 'Failed to load settings.');
        return;
      }
      const payload = (await response.json()) as { settings: AdminSettings };
      const loaded = normalizeAdminSettings(payload.settings) ?? defaultSettings;
      setSettings({
        ...loaded,
        prompts: {
          system: loaded.prompts.system || DEFAULT_ADMIN_SETTINGS.prompts.system,
          chatPromptTemplate: loaded.prompts.chatPromptTemplate || '',
          summarizePromptTemplate: loaded.prompts.summarizePromptTemplate || DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate,
          highlightsPromptTemplate: loaded.prompts.highlightsPromptTemplate || DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate,
        },
      });
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load settings.');
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateSettings = (next: AdminSettings) => {
    setSaved(false);
    setSettings(next);
  };

  const handleSave = async () => {
    if (validation.length > 0) {
      setErrorMessage(validation[0]);
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSaved(false);

    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing: settings.routing,
          prompts: settings.prompts,
          tasks: settings.tasks,
          safety: settings.safety,
        }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setStatus(response.status === 401 ? 'reconnect' : 'error');
        setErrorMessage(apiError?.message ?? 'Failed to save settings.');
        return;
      }

      const payload = (await response.json()) as { settings: AdminSettings };
      setSettings(payload.settings);
      setStatus('ready');
      setSaved(true);
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (validation.length > 0) {
      setErrorMessage(validation[0]);
      return;
    }

    setIsTesting(true);
    setErrorMessage(null);
    setTestResult(null);

    try {
      const response = await fetch('/api/admin/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.routing.default.provider,
          model: settings.routing.default.model,
          systemPrompt: settings.prompts.system,
          summarizePromptTemplate: settings.prompts.summarizePromptTemplate,
          highlightsPromptTemplate: settings.prompts.highlightsPromptTemplate,
          maxOutputTokens: settings.tasks.summarize.maxOutputTokens,
          temperature: settings.tasks.summarize.temperature,
        }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setErrorMessage(apiError?.message ?? 'Failed to test provider.');
        return;
      }

      setTestResult((await response.json()) as TestResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to test provider.');
    } finally {
      setIsTesting(false);
    }
  };

  const handleBackfill = async () => {
    if (!enableBackfill) {
      setErrorMessage('Enable maintenance backfill before running.');
      return;
    }

    setIsRunningBackfill(true);
    setBackfillResult(null);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/timeline/artifacts/backfill-content-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: backfillLimit, dryRun: backfillDryRun }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setErrorMessage(apiError?.message ?? 'Failed to run backfill.');
        return;
      }

      setBackfillResult((await response.json()) as BackfillResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to run backfill.');
    } finally {
      setIsRunningBackfill(false);
    }
  };

  if (status === 'loading') return <p className={styles.notice}>Loading settings…</p>;
  if (status === 'reconnect') return <p className={styles.notice}>Please reconnect to manage admin settings.</p>;

  return (
    <div className={styles.form}>
      {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}
      {saved ? <p className={styles.saved}>Saved.</p> : null}
      {validation.length > 0 ? <ul className={styles.validation}>{validation.map((error) => <li key={error}>{error}</li>)}</ul> : null}

      <h3>Model routing</h3>
      <label className={styles.field}><span>Default provider</span><select value={settings.routing.default.provider} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, default: { ...settings.routing.default, provider: event.target.value as AdminSettings['routing']['default']['provider'] } } })}><option value="stub">stub</option><option value="openai">openai</option><option value="gemini">gemini</option></select></label>
      <label className={styles.field}><span>Default model</span><input type="text" value={settings.routing.default.model} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, default: { ...settings.routing.default, model: event.target.value } } })} /></label>

      <label className={styles.inlineField}><input type="checkbox" checked={Boolean(settings.routing.tasks?.chat)} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: event.target.checked ? { ...settings.routing.tasks, chat: settings.routing.tasks?.chat ?? { ...settings.routing.default } } : { ...settings.routing.tasks, chat: undefined } } })} /><span>Override chat routing</span></label>
      {settings.routing.tasks?.chat ? <><label className={styles.field}><span>Chat provider</span><select value={settings.routing.tasks.chat.provider} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: { ...settings.routing.tasks, chat: { ...settings.routing.tasks!.chat!, provider: event.target.value as AdminSettings['routing']['default']['provider'] } } } })}><option value="stub">stub</option><option value="openai">openai</option><option value="gemini">gemini</option></select></label><label className={styles.field}><span>Chat model</span><input type="text" value={settings.routing.tasks.chat.model} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: { ...settings.routing.tasks, chat: { ...settings.routing.tasks!.chat!, model: event.target.value } } } })} /></label></> : null}

      <label className={styles.inlineField}><input type="checkbox" checked={Boolean(settings.routing.tasks?.summarize)} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: event.target.checked ? { ...settings.routing.tasks, summarize: settings.routing.tasks?.summarize ?? { ...settings.routing.default } } : { ...settings.routing.tasks, summarize: undefined } } })} /><span>Override summarize routing</span></label>
      {settings.routing.tasks?.summarize ? <><label className={styles.field}><span>Summarize provider</span><select value={settings.routing.tasks.summarize.provider} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: { ...settings.routing.tasks, summarize: { ...settings.routing.tasks!.summarize!, provider: event.target.value as AdminSettings['routing']['default']['provider'] } } } })}><option value="stub">stub</option><option value="openai">openai</option><option value="gemini">gemini</option></select></label><label className={styles.field}><span>Summarize model</span><input type="text" value={settings.routing.tasks.summarize.model} onChange={(event) => updateSettings({ ...settings, routing: { ...settings.routing, tasks: { ...settings.routing.tasks, summarize: { ...settings.routing.tasks!.summarize!, model: event.target.value } } } })} /></label></> : null}

      <h3>Task budgets</h3>
      {(['chat', 'summarize'] as const).map((task) => (
        <div key={task}>
          <p>{task}</p>
          <label className={styles.field}><span>Temperature</span><input type="number" step="0.1" min={0} max={2} value={settings.tasks[task].temperature} onChange={(event) => updateSettings({ ...settings, tasks: { ...settings.tasks, [task]: { ...settings.tasks[task], temperature: toFloat(event.target.value) } } })} /></label>
          <label className={styles.field}><span>Max context items</span><input type="number" min={1} value={settings.tasks[task].maxContextItems} onChange={(event) => updateSettings({ ...settings, tasks: { ...settings.tasks, [task]: { ...settings.tasks[task], maxContextItems: toPositiveInteger(event.target.value) } } })} /></label>
          <label className={styles.field}><span>Max output tokens (optional)</span><input type="number" min={1} value={settings.tasks[task].maxOutputTokens ?? ''} onChange={(event) => updateSettings({ ...settings, tasks: { ...settings.tasks, [task]: { ...settings.tasks[task], maxOutputTokens: event.target.value.trim() ? toPositiveInteger(event.target.value) : undefined } } })} /></label>
        </div>
      ))}

      <h3>Prompts</h3>

      <div className={styles.field}>
        <span>System prompt</span>
        <textarea
          rows={5}
          value={settings.prompts.system}
          placeholder={DEFAULT_ADMIN_SETTINGS.prompts.system}
          onChange={(event) => updateSettings({ ...settings, prompts: { ...settings.prompts, system: event.target.value } })}
        />
        {settings.prompts.system !== DEFAULT_ADMIN_SETTINGS.prompts.system ? (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => updateSettings({ ...settings, prompts: { ...settings.prompts, system: DEFAULT_ADMIN_SETTINGS.prompts.system } })}
          >
            Reset to default
          </button>
        ) : null}
      </div>

      <div className={styles.field}>
        <span>Chat prompt template <span className={styles.optionalLabel}>(optional — leave blank to use system prompt)</span></span>
        <textarea
          rows={4}
          value={settings.prompts.chatPromptTemplate ?? ''}
          placeholder="Leave blank to use the system prompt for chat."
          onChange={(event) => updateSettings({ ...settings, prompts: { ...settings.prompts, chatPromptTemplate: event.target.value } })}
        />
      </div>

      <div className={styles.field}>
        <span>Summarize prompt template <span className={styles.optionalLabel}>(optional)</span></span>
        <textarea
          rows={4}
          value={settings.prompts.summarizePromptTemplate ?? ''}
          placeholder={DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate}
          onChange={(event) => updateSettings({ ...settings, prompts: { ...settings.prompts, summarizePromptTemplate: event.target.value } })}
        />
        {settings.prompts.summarizePromptTemplate !== DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate ? (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => updateSettings({ ...settings, prompts: { ...settings.prompts, summarizePromptTemplate: DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate } })}
          >
            Reset to default
          </button>
        ) : null}
      </div>

      <div className={styles.field}>
        <span>Highlights prompt template <span className={styles.optionalLabel}>(optional)</span></span>
        <textarea
          rows={3}
          value={settings.prompts.highlightsPromptTemplate ?? ''}
          placeholder={DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate}
          onChange={(event) => updateSettings({ ...settings, prompts: { ...settings.prompts, highlightsPromptTemplate: event.target.value } })}
        />
        {settings.prompts.highlightsPromptTemplate !== DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate ? (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => updateSettings({ ...settings, prompts: { ...settings.prompts, highlightsPromptTemplate: DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate } })}
          >
            Reset to default
          </button>
        ) : null}
      </div>

      <label className={styles.field}><span>Safety mode</span><select value={settings.safety.mode} onChange={(event) => updateSettings({ ...settings, safety: { mode: event.target.value as AdminSettings['safety']['mode'] } })}><option value="standard">standard</option><option value="strict">strict</option></select></label>

      <p className={styles.helper}>Supported template tokens: {'{title}'}, {'{text}'}, {'{source}'}, {'{metadata}'}.</p>

      <div className={styles.actions}>
        <button type="button" onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={handleTest} disabled={isTesting}>{isTesting ? 'Testing…' : 'Test current settings'}</button>
      </div>

      {testResult ? (<div className={styles.result}><p><strong>{testResult.provider} / {testResult.model}</strong> ({testResult.timings.ms} ms)</p><p>{testResult.summary}</p>{testResult.highlights.length > 0 ? (<ul>{testResult.highlights.map((highlight) => (<li key={highlight}>{highlight}</li>))}</ul>) : null}</div>) : null}

      <section className={styles.maintenanceSection}>
        <h3 className={styles.maintenanceTitle}>Maintenance</h3>
        <label className={styles.inlineField}>
          <input type="checkbox" checked={enableBackfill} onChange={(event) => setEnableBackfill(event.target.checked)} />
          <span>Backfill content dates for existing summaries</span>
        </label>

        <div className={styles.maintenanceControls}>
          <label className={styles.inlineField}>
            <input type="checkbox" checked={backfillDryRun} onChange={(event) => setBackfillDryRun(event.target.checked)} />
            <span>Dry run</span>
          </label>

          <label className={styles.inlineField}>
            <span>Limit</span>
            <select value={backfillLimit} onChange={(event) => setBackfillLimit(Number(event.target.value) as 10 | 25)}><option value={10}>10</option><option value={25}>25</option></select>
          </label>

          <button type="button" onClick={handleBackfill} disabled={isRunningBackfill || !enableBackfill}>{isRunningBackfill ? 'Running…' : 'Run backfill'}</button>
        </div>

        {backfillResult ? (<div className={styles.result}><p>scanned: {backfillResult.scanned} · updated: {backfillResult.updated} · skipped: {backfillResult.skippedAlreadyHasDate} · no date found: {backfillResult.noDateFound}</p><ul>{backfillResult.items.slice(0, 10).map((item) => (<li key={item.fileId}><a href={`https://drive.google.com/file/d/${item.fileId}/view`} target="_blank" rel="noreferrer">{item.title}</a> — {item.status} ({item.before ?? 'none'} → {item.after ?? 'none'})</li>))}</ul></div>) : null}
      </section>
    </div>
  );
}
