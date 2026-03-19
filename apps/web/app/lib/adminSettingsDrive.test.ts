import { describe, expect, it, vi } from 'vitest';

import { createDefaultAdminSettings } from './adminSettings';
import { readAdminSettingsFromDrive } from './adminSettingsDrive';

const createDriveMock = () =>
  ({
    files: {
      list: vi.fn(),
      get: vi.fn(),
    },
  }) as unknown as {
    files: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  };

describe('readAdminSettingsFromDrive', () => {
  it('returns defaults when settings file is missing', async () => {
    const drive = createDriveMock();
    drive.files.list.mockResolvedValue({ data: { files: [] } });

    const result = await readAdminSettingsFromDrive(drive as never, 'folder-1');

    expect(result.settings.routing.default.provider).toBe('openai');
    expect(result.settings.routing.default.model).toBe(createDefaultAdminSettings().routing.default.model);
    expect(result.fileId).toBeUndefined();
  });

  it('returns stored settings when file exists', async () => {
    const drive = createDriveMock();
    drive.files.list.mockResolvedValue({
      data: { files: [{ id: 'file-1', webViewLink: 'https://drive.test/file-1' }] },
    });
    drive.files.get.mockResolvedValue({
      data: JSON.stringify({
        type: 'admin_settings',
        version: 1,
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'Hello',
        maxContextItems: 6,
        temperature: 0.3,
        updatedAtISO: '2024-01-01T00:00:00Z',
      }),
    });

    const result = await readAdminSettingsFromDrive(drive as never, 'folder-1');

    expect(result.settings.routing.default.provider).toBe('openai');
    expect(result.settings.routing.default.model).toBe('gpt-4o');
    expect(result.settings.tasks.chat.maxContextItems).toBe(6);
    expect(result.settings.tasks.summarize.maxContextItems).toBe(6);
    expect(result.fileId).toBe('file-1');
    expect(result.webViewLink).toBe('https://drive.test/file-1');
  });
});
