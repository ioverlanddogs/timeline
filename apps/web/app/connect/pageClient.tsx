'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { signIn, signOut } from 'next-auth/react';

import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { REQUIRED_GOOGLE_SCOPES } from '../lib/googleAuth';
import styles from './connect.module.css';

type ScopeStatus = {
  configured: string[];
  missing: string[];
  isComplete: boolean;
};

type ConnectPageClientProps = {
  initial: {
    isConfigured: boolean;
    signedIn: boolean;
    email: string | null;
    scopes: string[];
    driveFolderId: string | null;
  };
  scopeStatus: ScopeStatus;
};

type HealthState = {
  isLoading: boolean;
  reachable: boolean;
  warnings: string[];
  checkedAt: string | null;
  error: string | null;
};

const DRIVE_SCOPE_SET = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
const GMAIL_SCOPE_SET = ['https://www.googleapis.com/auth/gmail.readonly'];
const CALENDAR_SCOPE_SET = ['https://www.googleapis.com/auth/calendar.events'];

const hasAllScopes = (grantedScopes: string[], requiredScopes: string[]) =>
  requiredScopes.every((scope) => grantedScopes.includes(scope));

const parseError = async (response: Response) => {
  let message = 'Request failed.';

  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    if (payload.error?.message) {
      message = payload.error.message;
    }
  } catch {
    // Ignore invalid json responses.
  }

  if (response.status === 401) {
    return "You're not signed in.";
  }

  if (response.status === 403) {
    return 'Access denied.';
  }

  return message;
};

const inferHealthWarnings = (payload: Record<string, unknown>) => {
  const warnings = new Set<string>();

  const payloadWarnings = payload.warnings;
  if (Array.isArray(payloadWarnings)) {
    payloadWarnings
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .forEach((value) => warnings.add(value));
  }

  const missingEnv = payload.missingEnv;
  if (Array.isArray(missingEnv)) {
    missingEnv
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .forEach((value) => warnings.add(`Admin must configure: ${value}`));
  }

  return Array.from(warnings);
};

const formatTimestamp = (value: string | null) => {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
};

export default function ConnectPageClient({ initial, scopeStatus }: ConnectPageClientProps) {
  const [authState, setAuthState] = useState({
    signedIn: initial.signedIn,
    email: initial.email,
    scopes: initial.scopes,
  });
  const [driveFolderId, setDriveFolderId] = useState<string | null>(initial.driveFolderId);
  const [healthState, setHealthState] = useState<HealthState>({
    isLoading: true,
    reachable: false,
    warnings: [],
    checkedAt: null,
    error: null,
  });
  const [provisionLoading, setProvisionLoading] = useState(false);
  const [disconnectLoading, setDisconnectLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  const capabilityStatus = useMemo(() => {
    const scopes = authState.scopes;
    if (!authState.signedIn) {
      return { drive: false, gmail: false, calendar: false, unknown: false };
    }

    if (!scopes.length) {
      return { drive: false, gmail: false, calendar: false, unknown: true };
    }

    return {
      drive: hasAllScopes(scopes, DRIVE_SCOPE_SET),
      gmail: hasAllScopes(scopes, GMAIL_SCOPE_SET),
      calendar: hasAllScopes(scopes, CALENDAR_SCOPE_SET),
      unknown: false,
    };
  }, [authState.scopes, authState.signedIn]);

  const refreshHealth = useCallback(async () => {
    setHealthState((previous) => ({ ...previous, isLoading: true, error: null }));

    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Health endpoint unavailable.');
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const warnings = inferHealthWarnings(payload);
      setHealthState({
        isLoading: false,
        reachable: true,
        warnings,
        checkedAt: typeof payload.ts === 'string' ? payload.ts : new Date().toISOString(),
        error: null,
      });
    } catch {
      setHealthState({
        isLoading: false,
        reachable: false,
        warnings: [],
        checkedAt: new Date().toISOString(),
        error: 'Unable to reach /api/health.',
      });
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const handleReconnect = async () => {
    await signIn('google', { callbackUrl: '/connect' });
  };

  const handleDisconnect = async () => {
    setDisconnectLoading(true);
    setAuthError(null);

    try {
      const response = await fetch('/api/google/disconnect', { method: 'POST' });
      if (!response.ok && response.status !== 401) {
        setAuthError(await parseError(response));
        return;
      }

      setAuthState({ signedIn: false, email: null, scopes: [] });
      setDriveFolderId(null);
      await signOut({ callbackUrl: '/connect' });
    } catch {
      setAuthError('Unable to disconnect right now.');
    } finally {
      setDisconnectLoading(false);
    }
  };

  const handleProvision = async () => {
    setProvisionLoading(true);
    setDriveError(null);

    try {
      const response = await fetch('/api/google/drive/provision', { method: 'POST' });
      if (!response.ok) {
        setDriveError(await parseError(response));
        return;
      }

      const payload = (await response.json()) as { folderId?: string };
      if (!payload.folderId) {
        setDriveError('Provisioning completed without a folder id.');
        return;
      }

      setDriveFolderId(payload.folderId);
      await refreshHealth();
    } catch {
      setDriveError('Unable to provision the Drive folder.');
    } finally {
      setProvisionLoading(false);
    }
  };

  const folderUrl = driveFolderId ? `https://drive.google.com/drive/folders/${driveFolderId}` : null;
  const adminMisconfigured = !initial.isConfigured || !scopeStatus.isComplete;
  const missingRequiredScopes = REQUIRED_GOOGLE_SCOPES.filter(
    (scope) => !scopeStatus.configured.includes(scope),
  );

  return (
    <section className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>Connect</h1>
          <p>Check your Google connection status and fix issues in one place.</p>
        </div>
      </div>

      <div className={styles.grid}>
        <Card>
          <h2>1) Account &amp; Auth</h2>
          <p className={styles.muted}>Make sure you are signed in with the right Google account.</p>
          <ul className={styles.statusList}>
            <li>
              <span>Status</span>
              <Badge tone={authState.signedIn ? 'success' : 'warning'}>
                {authState.signedIn ? 'Signed in' : 'Signed out'}
              </Badge>
            </li>
            <li>
              <span>Email</span>
              <span className={styles.muted}>{authState.email ?? '—'}</span>
            </li>
            <li>
              <span>Drive</span>
              <Badge tone={capabilityStatus.drive ? 'success' : 'warning'}>
                {capabilityStatus.unknown
                  ? 'Unknown'
                  : capabilityStatus.drive
                    ? 'Ready'
                    : 'Needs scope'}
              </Badge>
            </li>
            <li>
              <span>Gmail</span>
              <Badge tone={capabilityStatus.gmail ? 'success' : 'warning'}>
                {capabilityStatus.unknown
                  ? 'Unknown'
                  : capabilityStatus.gmail
                    ? 'Ready'
                    : 'Needs scope'}
              </Badge>
            </li>
            <li>
              <span>Calendar</span>
              <Badge tone={capabilityStatus.calendar ? 'success' : 'warning'}>
                {capabilityStatus.unknown
                  ? 'Unknown'
                  : capabilityStatus.calendar
                    ? 'Ready'
                    : 'Needs scope'}
              </Badge>
            </li>
          </ul>
          {capabilityStatus.unknown ? (
            <p className={styles.muted}>We&apos;ll verify exact scopes on first use.</p>
          ) : null}
          {!authState.signedIn ? (
            <p className={styles.error}>Sign in required to use Drive, Gmail, and Calendar.</p>
          ) : null}
          {adminMisconfigured ? (
            <p className={styles.error}>Admin must finish Google OAuth environment configuration.</p>
          ) : null}
          {!!missingRequiredScopes.length ? (
            <p className={styles.muted}>Missing required scopes: {missingRequiredScopes.join(', ')}</p>
          ) : null}
          <div className={styles.actions}>
            <Button onClick={handleReconnect} variant="primary" disabled={!initial.isConfigured}>
              Reconnect Google
            </Button>
            <Button
              onClick={handleDisconnect}
              variant="secondary"
              disabled={!authState.signedIn || disconnectLoading}
            >
              {disconnectLoading ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
          {authError ? <p className={styles.error}>{authError}</p> : null}
        </Card>

        <Card>
          <h2>2) Drive Folder Provisioning</h2>
          <p className={styles.muted}>Timeline writes app artifacts only after you explicitly provision.</p>
          <ul className={styles.statusList}>
            <li>
              <span>Status</span>
              <Badge tone={driveFolderId ? 'success' : 'warning'}>
                {driveFolderId ? 'Provisioned' : 'Not provisioned'}
              </Badge>
            </li>
            <li>
              <span>Folder ID</span>
              <span className={styles.muted}>{driveFolderId ?? '—'}</span>
            </li>
          </ul>
          {folderUrl ? (
            <p className={styles.muted}>
              <a href={folderUrl} target="_blank" rel="noreferrer">
                Open folder in Drive
              </a>
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button
              onClick={handleProvision}
              variant="primary"
              disabled={!authState.signedIn || provisionLoading || adminMisconfigured}
            >
              {provisionLoading ? 'Provisioning...' : 'Provision Drive folder'}
            </Button>
          </div>
          {driveError ? <p className={styles.error}>{driveError}</p> : null}
        </Card>

        <Card>
          <h2>3) Diagnostics</h2>
          <p className={styles.muted}>Check API health and environment warnings.</p>
          <ul className={styles.statusList}>
            <li>
              <span>API /api/health</span>
              <Badge tone={healthState.reachable ? 'success' : 'warning'}>
                {healthState.isLoading
                  ? 'Checking...'
                  : healthState.reachable
                    ? 'Reachable'
                    : 'Unreachable'}
              </Badge>
            </li>
            <li>
              <span>Last checked</span>
              <span className={styles.muted}>{formatTimestamp(healthState.checkedAt)}</span>
            </li>
          </ul>
          {healthState.error ? <p className={styles.error}>{healthState.error}</p> : null}
          {healthState.warnings.map((warning) => (
            <p key={warning} className={styles.error}>
              Admin must configure: {warning.replace(/^Admin must configure:\s*/i, '')}
            </p>
          ))}
          <div className={styles.actions}>
            <Button onClick={() => void refreshHealth()} variant="secondary" disabled={healthState.isLoading}>
              Refresh status
            </Button>
          </div>
        </Card>
      </div>

      <p className={styles.muted}>
        Next step: <Link href="/getting-started">Go to Getting Started</Link>
      </p>
    </section>
  );
}
