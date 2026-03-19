import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/googleAuth', () => ({
  getGoogleSession: vi.fn(),
  getGoogleAccessToken: vi.fn(),
}));

vi.mock('../../../lib/googleDrive', () => ({
  createDriveClient: vi.fn(),
}));

vi.mock('../../../lib/googleGmail', () => ({
  createGmailClient: vi.fn(),
}));

vi.mock('../../../lib/fetchSourceText', () => ({
  fetchGmailMessageText: vi.fn(),
  fetchDriveFileText: vi.fn(),
}));

vi.mock('../../../lib/llm/providerRouter', () => ({
  getTimelineProviderFromDrive: vi.fn(),
}));

vi.mock('../../../lib/writeArtifactToDrive', () => ({
  writeArtifactToDrive: vi.fn(),
}));

vi.mock('../../../lib/timeline/artifactIndex', () => ({
  upsertArtifactIndex: vi.fn(),
}));

import { getGoogleAccessToken, getGoogleSession } from '../../../lib/googleAuth';
import { createDriveClient } from '../../../lib/googleDrive';
import { createGmailClient } from '../../../lib/googleGmail';
import { fetchDriveFileText, fetchGmailMessageText } from '../../../lib/fetchSourceText';
import { ProviderError } from '../../../lib/llm/providerErrors';
import { getTimelineProviderFromDrive } from '../../../lib/llm/providerRouter';
import { writeArtifactToDrive } from '../../../lib/writeArtifactToDrive';
import { POST } from './route';

const mockGetGoogleSession = vi.mocked(getGoogleSession);
const mockGetGoogleAccessToken = vi.mocked(getGoogleAccessToken);
const mockCreateDriveClient = vi.mocked(createDriveClient);
const mockCreateGmailClient = vi.mocked(createGmailClient);
const mockFetchGmailMessageText = vi.mocked(fetchGmailMessageText);
const mockFetchDriveFileText = vi.mocked(fetchDriveFileText);
const mockGetTimelineProviderFromDrive = vi.mocked(getTimelineProviderFromDrive);
const mockWriteArtifactToDrive = vi.mocked(writeArtifactToDrive);

describe('POST /api/timeline/summarize', () => {
  it('returns reconnect_required when not authenticated', async () => {
    mockGetGoogleSession.mockResolvedValue(null);
    mockGetGoogleAccessToken.mockResolvedValue(null);

    const response = await POST(new Request('http://localhost/api/timeline/summarize') as never);

    expect(response.status).toBe(401);
  });


  it('returns drive_not_provisioned when session has no drive folder', async () => {
    mockGetGoogleSession.mockResolvedValue({ user: { email: 'test@example.com' } } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'drive_not_provisioned',
      error_code: 'drive_not_provisioned',
    });
  });

  it('returns invalid_request with details for invalid payload shape', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1', user: { email: 'test@example.com' } } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_code: 'invalid_request',
      details: {
        issues: expect.any(Array),
      },
    });
  });

  it('returns provider_not_configured when provider credentials are missing', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1' } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateDriveClient.mockReturnValue({} as never);
    mockCreateGmailClient.mockReturnValue({} as never);
    mockGetTimelineProviderFromDrive.mockRejectedValue(
      new ProviderError({
        code: 'not_configured',
        status: 500,
        provider: 'openai',
        message: 'Provider not configured.',
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'provider_not_configured', error_code: 'provider_not_configured' });
  });

  it('records provider_bad_output as an item failure when provider output is malformed', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1' } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateDriveClient.mockReturnValue({} as never);
    mockCreateGmailClient.mockReturnValue({} as never);
    mockFetchGmailMessageText.mockResolvedValue({ title: 'Demo', text: 'Hello', metadata: {} });
    mockGetTimelineProviderFromDrive.mockResolvedValue({
      settings: { provider: 'openai', model: 'gpt-4o-mini' },
      provider: {
        summarize: vi.fn().mockRejectedValue(
          new ProviderError({
            code: 'bad_output',
            status: 502,
            provider: 'timeline',
            message: 'bad output',
          }),
        ),
      },
    } as never);

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      artifacts: [],
      failed: [{ source: 'gmail', id: 'id-1', error: 'provider_bad_output' }],
    });
  });

  it('records provider_not_configured as an item failure when summarize fails per item', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1' } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateDriveClient.mockReturnValue({} as never);
    mockCreateGmailClient.mockReturnValue({} as never);
    mockFetchGmailMessageText.mockResolvedValue({ title: 'Demo', text: 'Hello', metadata: {} });
    mockGetTimelineProviderFromDrive.mockResolvedValue({
      settings: { provider: 'openai', model: 'gpt-4o-mini' },
      provider: {
        summarize: vi.fn().mockRejectedValue(
          new ProviderError({
            code: 'not_configured',
            status: 500,
            provider: 'timeline',
            message: 'not configured',
          }),
        ),
      },
    } as never);

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      artifacts: [],
      failed: [{ source: 'gmail', id: 'id-1', error: 'provider_not_configured' }],
    });
  });

  it('returns summary artifacts with selected provider model', async () => {

    mockGetGoogleSession.mockResolvedValue({
      driveFolderId: 'folder-1',
      user: { email: 'test@example.com' },
    } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateDriveClient.mockReturnValue({} as never);
    mockCreateGmailClient.mockReturnValue({} as never);
    mockFetchGmailMessageText.mockResolvedValue({
      title: 'Demo',
      text: 'Hello world',
      metadata: { subject: 'Demo subject' },
    });
    mockGetTimelineProviderFromDrive.mockResolvedValue({
      settings: { provider: 'stub', model: 'stub-model' },
      provider: {
        summarize: vi.fn().mockResolvedValue({
          summary: 'Summary text',
          highlights: ['Point A'],
          contentDateISO: '2024-04-15T10:30:00Z',
          model: 'stub-model',
        }),
      },
    } as never);
    mockWriteArtifactToDrive.mockResolvedValue({
      markdownFileId: 'md-1',
      markdownWebViewLink: 'https://drive.google.com/md-1',
      jsonFileId: 'json-1',
      jsonWebViewLink: 'https://drive.google.com/json-1',
    });

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ artifacts: expect.any(Array), failed: expect.any(Array) });
    expect(payload.artifacts[0].model).toBe('stub-model');
    expect(payload.artifacts[0].contentDateISO).toBe('2024-04-15T10:30:00Z');
    expect(mockWriteArtifactToDrive).toHaveBeenCalledWith(
      expect.anything(),
      'folder-1',
      expect.objectContaining({ contentDateISO: '2024-04-15T10:30:00Z' }),
      expect.anything(),
    );
  });

  it('uses routing.tasks.summarize override model when configured', async () => {
    const summarize = vi.fn().mockResolvedValue({
      summary: 'Summary text',
      highlights: ['h1'],
      model: 'gemini-1.5-flash',
    });

    mockGetTimelineProviderFromDrive.mockResolvedValue({
      provider: { summarize } as never,
      settings: {
        type: 'admin_settings',
        version: 2,
        routing: {
          default: { provider: 'openai', model: 'gpt-4o-mini' },
          tasks: { summarize: { provider: 'gemini', model: 'gemini-1.5-flash' } },
        },
        prompts: { system: '' },
        tasks: {
          chat: { maxContextItems: 8, temperature: 0.2 },
          summarize: { maxContextItems: 8, temperature: 0.2 },
        },
        safety: { mode: 'standard' },
        updatedAtISO: '2026-01-01T00:00:00Z',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'msg-1' }] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(summarize).toHaveBeenCalled();
    const [, settingsArg] = summarize.mock.calls[0] as [unknown, { routing: { default: { model: string } } }];
    expect(settingsArg.routing.default.model).toBe('gemini-1.5-flash');
  });

  it('persists suggestedActions with generated ids and proposed status', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1', user: { email: 'test@example.com' } } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateDriveClient.mockReturnValue({} as never);
    mockCreateGmailClient.mockReturnValue({} as never);
    mockFetchGmailMessageText.mockResolvedValue({ title: 'Demo', text: 'Please follow up and prepare tasks', metadata: {} });
    mockGetTimelineProviderFromDrive.mockResolvedValue({
      settings: { provider: 'stub', model: 'stub-model' },
      provider: {
        summarize: vi.fn().mockResolvedValue({
          summary: 'Summary text',
          highlights: ['Point A'],
          suggestedActions: [
            { type: 'reminder', text: 'Follow up with team' },
            { id: 'provider-id', type: 'task', text: 'Prepare follow-up note', dueDateISO: null },
          ],
          model: 'stub-model',
        }),
      },
    } as never);
    mockWriteArtifactToDrive.mockResolvedValue({
      markdownFileId: 'md-1',
      markdownWebViewLink: 'https://drive.google.com/md-1',
      jsonFileId: 'json-1',
      jsonWebViewLink: 'https://drive.google.com/json-1',
    });

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({ items: [{ source: 'gmail', id: 'id-1' }] }),
      }) as never,
    );

    expect(response.status).toBe(200);
    const writtenArtifact = mockWriteArtifactToDrive.mock.calls.at(-1)?.[2] as { suggestedActions?: Array<{ id: string; status: string }> };
    expect(writtenArtifact.suggestedActions).toBeDefined();
    expect(writtenArtifact.suggestedActions?.[0].id).toMatch(/^act_/);
    expect(writtenArtifact.suggestedActions?.[0].status).toBe('proposed');
    expect(writtenArtifact.suggestedActions?.[1].id).toBe('provider-id');
  });


  it('supports url selections and persists url metadata in artifacts', async () => {
    mockGetGoogleSession.mockResolvedValue({ driveFolderId: 'folder-1', user: { email: 'test@example.com' } } as never);
    mockGetGoogleAccessToken.mockResolvedValue('token');
    mockCreateGmailClient.mockReturnValue({} as never);
    mockCreateDriveClient.mockReturnValue({
      files: {
        get: vi.fn().mockResolvedValue({
          data: JSON.stringify({
            url: 'https://example.com/source',
            finalUrl: 'https://example.com/final',
            fetchedAtISO: '2024-05-01T12:00:00Z',
            title: 'Fetched title',
          }),
        }),
      },
    } as never);
    mockFetchDriveFileText.mockResolvedValue({ title: 'Raw URL', text: 'URL text content', metadata: { mimeType: 'text/plain' } });
    mockGetTimelineProviderFromDrive.mockResolvedValue({
      settings: { provider: 'stub', model: 'stub-model' },
      provider: {
        summarize: vi.fn().mockResolvedValue({
          summary: 'Summary text',
          highlights: ['Point A'],
          evidence: [{ excerpt: 'Evidence excerpt' }],
          suggestedActions: [{ type: 'task', text: 'Do thing' }],
          contentDateISO: '2024-04-15T10:30:00Z',
          model: 'stub-model',
        }),
      },
    } as never);
    mockWriteArtifactToDrive.mockResolvedValue({
      markdownFileId: 'md-1',
      markdownWebViewLink: 'https://drive.google.com/md-1',
      jsonFileId: 'json-1',
      jsonWebViewLink: 'https://drive.google.com/json-1',
    });

    const response = await POST(
      new Request('http://localhost/api/timeline/summarize', {
        method: 'POST',
        body: JSON.stringify({
          items: [
            {
              kind: 'url',
              url: 'https://example.com/source',
              driveTextFileId: 'text-id',
              driveMetaFileId: 'meta-id',
              title: 'Hint title',
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    const writtenArtifact = mockWriteArtifactToDrive.mock.calls.at(-1)?.[2] as {
      sourceMetadata?: { url?: string; finalUrl?: string; driveMetaFileId?: string };
      contentDateISO?: string;
      evidence?: Array<{ excerpt: string }>;
      suggestedActions?: Array<{ status: string }>;
    };
    expect(writtenArtifact.sourceMetadata?.url).toBe('https://example.com/source');
    expect(writtenArtifact.sourceMetadata?.finalUrl).toBe('https://example.com/final');
    expect(writtenArtifact.sourceMetadata?.driveMetaFileId).toBe('meta-id');
    expect(writtenArtifact.contentDateISO).toBe('2024-04-15T10:30:00Z');
    expect(writtenArtifact.evidence?.length).toBeGreaterThan(0);
    expect(writtenArtifact.suggestedActions?.[0]?.status).toBe('proposed');
  });


});
