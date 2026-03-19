import { AdminSettingsSchema, type AdminSettings } from '@timeline/shared';

import type { LLMProviderName } from './llm/types';

export type { AdminSettings };

type TaskConfigInput = {
  temperature?: number;
  maxContextItems?: number;
  maxOutputTokens?: number;
};

export type AdminSettingsInput = {
  routing?: {
    default?: {
      provider?: LLMProviderName;
      model?: string;
    };
    tasks?: {
      chat?: {
        provider?: LLMProviderName;
        model?: string;
      };
      summarize?: {
        provider?: LLMProviderName;
        model?: string;
      };
    };
  };
  prompts?: {
    system?: string;
    chatPromptTemplate?: string;
    summarizePromptTemplate?: string;
    highlightsPromptTemplate?: string;
  };
  tasks?: {
    chat?: TaskConfigInput;
    summarize?: TaskConfigInput;
  };
  safety?: {
    mode?: 'standard' | 'strict';
  };
};

const DEFAULT_TASK_SETTINGS = {
  temperature: 0.2,
  maxContextItems: 8,
  maxOutputTokens: 256,
};

export const DEFAULT_ADMIN_SETTINGS: Omit<AdminSettings, 'updatedAtISO'> = {
  type: 'admin_settings',
  version: 2,
  routing: {
    default: {
      provider: 'openai',
      model: 'gpt-4o-mini',
    },
  },
  prompts: {
    system:
      'You are a precise, factual assistant helping a user understand their personal timeline of documents and communications. Ground every response in the provided source content. Be concise and avoid speculation.',
    chatPromptTemplate: '',
    summarizePromptTemplate:
      'Summarise the following document accurately and concisely. Extract the key facts, decisions, action items, and any dates mentioned. Stay grounded in the source text and do not add information that is not present.',
    highlightsPromptTemplate:
      'Extract the single most important takeaway from this document in one sentence of 20 words or fewer.',
  },
  tasks: {
    chat: { ...DEFAULT_TASK_SETTINGS },
    summarize: { ...DEFAULT_TASK_SETTINGS },
  },
  safety: {
    mode: 'standard',
  },
};

const isProviderName = (value: unknown): value is LLMProviderName =>
  value === 'stub' || value === 'openai' || value === 'gemini';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const getTaskConfig = (task: unknown, fallback: (typeof DEFAULT_ADMIN_SETTINGS.tasks)['chat']) => {
  const record = task && typeof task === 'object' ? (task as Record<string, unknown>) : {};
  return {
    temperature: isNumber(record.temperature) ? record.temperature : fallback.temperature,
    maxContextItems: isNumber(record.maxContextItems) ? record.maxContextItems : fallback.maxContextItems,
    maxOutputTokens: isNumber(record.maxOutputTokens) ? record.maxOutputTokens : fallback.maxOutputTokens,
  };
};

const getRoutingTask = (task: unknown) => {
  const record = task && typeof task === 'object' ? (task as Record<string, unknown>) : null;
  if (!record) {
    return undefined;
  }
  if (!isProviderName(record.provider) || typeof record.model !== 'string') {
    return undefined;
  }
  return { provider: record.provider, model: record.model };
};

export const createDefaultAdminSettings = (nowISO = new Date().toISOString()): AdminSettings => ({
  ...DEFAULT_ADMIN_SETTINGS,
  updatedAtISO: nowISO,
});

export const normalizeAdminSettings = (
  value: unknown,
  nowISO = new Date().toISOString(),
): AdminSettings | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'admin_settings') {
    return null;
  }

  const updatedAtISO = typeof record.updatedAtISO === 'string' && record.updatedAtISO.trim() ? record.updatedAtISO : nowISO;

  if (record.version === 2) {
    const routing = record.routing && typeof record.routing === 'object' ? (record.routing as Record<string, unknown>) : {};
    const routingDefault = routing.default && typeof routing.default === 'object' ? (routing.default as Record<string, unknown>) : {};
    const routingTasks = routing.tasks && typeof routing.tasks === 'object' ? (routing.tasks as Record<string, unknown>) : {};

    const prompts = record.prompts && typeof record.prompts === 'object' ? (record.prompts as Record<string, unknown>) : {};
    const tasks = record.tasks && typeof record.tasks === 'object' ? (record.tasks as Record<string, unknown>) : {};
    const safety = record.safety && typeof record.safety === 'object' ? (record.safety as Record<string, unknown>) : {};

    const normalized = {
      type: 'admin_settings' as const,
      version: 2 as const,
      routing: {
        default: {
          provider: isProviderName(routingDefault.provider)
            ? routingDefault.provider
            : DEFAULT_ADMIN_SETTINGS.routing.default.provider,
          model:
            typeof routingDefault.model === 'string' ? routingDefault.model : DEFAULT_ADMIN_SETTINGS.routing.default.model,
        },
        ...(getRoutingTask(routingTasks.chat) || getRoutingTask(routingTasks.summarize)
          ? {
              tasks: {
                ...(getRoutingTask(routingTasks.chat) ? { chat: getRoutingTask(routingTasks.chat) } : {}),
                ...(getRoutingTask(routingTasks.summarize) ? { summarize: getRoutingTask(routingTasks.summarize) } : {}),
              },
            }
          : {}),
      },
      prompts: {
        system: typeof prompts.system === 'string' ? prompts.system : DEFAULT_ADMIN_SETTINGS.prompts.system,
        chatPromptTemplate:
          typeof prompts.chatPromptTemplate === 'string'
            ? prompts.chatPromptTemplate
            : DEFAULT_ADMIN_SETTINGS.prompts.chatPromptTemplate,
        summarizePromptTemplate:
          typeof prompts.summarizePromptTemplate === 'string'
            ? prompts.summarizePromptTemplate
            : DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate,
        highlightsPromptTemplate:
          typeof prompts.highlightsPromptTemplate === 'string'
            ? prompts.highlightsPromptTemplate
            : DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate,
      },
      tasks: {
        chat: getTaskConfig(tasks.chat, DEFAULT_ADMIN_SETTINGS.tasks.chat),
        summarize: getTaskConfig(tasks.summarize, DEFAULT_ADMIN_SETTINGS.tasks.summarize),
      },
      safety: {
        mode: safety.mode === 'strict' ? 'strict' : 'standard',
      },
      updatedAtISO,
    };

    return AdminSettingsSchema.parse(normalized);
  }

  const provider = isProviderName(record.provider)
    ? record.provider
    : DEFAULT_ADMIN_SETTINGS.routing.default.provider;
  const model = typeof record.model === 'string' ? record.model : DEFAULT_ADMIN_SETTINGS.routing.default.model;
  const systemPrompt = typeof record.systemPrompt === 'string' ? record.systemPrompt : DEFAULT_ADMIN_SETTINGS.prompts.system;
  const summarizePromptTemplate =
    typeof record.summaryPromptTemplate === 'string'
      ? record.summaryPromptTemplate
      : DEFAULT_ADMIN_SETTINGS.prompts.summarizePromptTemplate;
  const highlightsPromptTemplate =
    typeof record.highlightsPromptTemplate === 'string'
      ? record.highlightsPromptTemplate
      : DEFAULT_ADMIN_SETTINGS.prompts.highlightsPromptTemplate;
  const maxOutputTokens = isNumber(record.maxOutputTokens)
    ? record.maxOutputTokens
    : DEFAULT_ADMIN_SETTINGS.tasks.chat.maxOutputTokens;
  const maxContextItems = isNumber(record.maxContextItems)
    ? record.maxContextItems
    : DEFAULT_ADMIN_SETTINGS.tasks.chat.maxContextItems;
  const temperature = isNumber(record.temperature) ? record.temperature : DEFAULT_ADMIN_SETTINGS.tasks.chat.temperature;

  return AdminSettingsSchema.parse({
    type: 'admin_settings',
    version: 2,
    routing: {
      default: {
        provider,
        model,
      },
    },
    prompts: {
      system: systemPrompt,
      summarizePromptTemplate,
      highlightsPromptTemplate,
      chatPromptTemplate: DEFAULT_ADMIN_SETTINGS.prompts.chatPromptTemplate,
    },
    tasks: {
      chat: {
        temperature,
        maxContextItems,
        maxOutputTokens,
      },
      summarize: {
        temperature,
        maxContextItems,
        maxOutputTokens,
      },
    },
    safety: {
      mode: 'standard',
    },
    updatedAtISO,
  });
};

export const validateAdminSettingsInput = (
  value: unknown,
  nowISO = new Date().toISOString(),
): { settings?: AdminSettings; error?: string } => {
  if (!value || typeof value !== 'object') {
    return { error: 'Settings payload must be an object.' };
  }

  const record = value as Record<string, unknown>;
  const normalized = normalizeAdminSettings(
    {
      type: 'admin_settings',
      version: 2,
      ...record,
      updatedAtISO: nowISO,
    },
    nowISO,
  );

  if (!normalized) {
    return { error: 'Invalid settings payload.' };
  }

  return { settings: normalized };
};
