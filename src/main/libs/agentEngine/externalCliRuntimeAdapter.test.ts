import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

import {
  CoworkAgentEngine,
  ExternalAgentConfigSource,
} from '../../../shared/cowork/constants';
import { ProviderName } from '../../../shared/providers';
import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import { setStoreGetter } from '../claudeSettings';
import { acquireWesightClaudeRuntimeConfig } from '../externalAgentConfigSync';
import type { ExternalAgentProvider } from '../externalAgentProviderStore';
import {
  appendNodeRequireOption,
  ExternalCliRuntimeAdapter,
} from './externalCliRuntimeAdapter';

const codexProvider: ExternalAgentProvider = {
  id: 'ccswitch-tokln',
  appType: 'codex',
  name: 'tokln.com',
  settingsConfig: {
    auth: {
      OPENAI_API_KEY: 'sk-test-provider-key',
    },
    config: [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      '',
      '[model_providers.custom]',
      'name = "custom"',
      'base_url = "https://api.tokln.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
    ].join('\n'),
  },
  category: 'cc-switch',
  isCurrent: true,
  createdAt: 1,
  updatedAt: 2,
  summary: {
    apiKey: 'sk-test-provider-key',
    baseUrl: 'https://api.tokln.com/v1',
    model: 'gpt-5.5',
  },
};

const createStore = (codexConfigSource = ExternalAgentConfigSource.LocalCli) => {
  const messages: CoworkMessage[] = [];
  const session = {
    id: 'session-1',
    messages,
    status: 'running',
  };
  const store = {
    getConfig: () => ({
      codexConfigSource,
    }),
    getSession: () => session,
    updateSession: (_sessionId: string, patch: Partial<typeof session>) => {
      Object.assign(session, patch);
    },
    addMessage: (_sessionId: string, input: Omit<CoworkMessage, 'id' | 'timestamp'>) => {
      const message = {
        ...input,
        id: `message-${messages.length + 1}`,
        timestamp: Date.now(),
      } as CoworkMessage;
      messages.push(message);
      return message;
    },
    updateMessage: (_sessionId: string, messageId: string, patch: Partial<CoworkMessage>) => {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        messages[index] = { ...messages[index], ...patch };
      }
    },
  } as unknown as CoworkStore;

  return { store, messages, session };
};

describe('appendNodeRequireOption', () => {
  test('escapes preload paths for NODE_OPTIONS without losing backslashes', () => {
    const scriptPath = 'C:\\Users\\Test User\\AppData\\Local\\Temp\\wesight "dev"\\external_cli_windows_hide_init.cjs';
    const nodeOptions = appendNodeRequireOption('--max-old-space-size=4096', scriptPath);

    expect(nodeOptions).toBe(
      '--max-old-space-size=4096 --require="C:\\\\Users\\\\Test User\\\\AppData\\\\Local\\\\Temp\\\\wesight \\"dev\\"\\\\external_cli_windows_hide_init.cjs"',
    );
  });

  test('does not append the same preload twice', () => {
    const scriptPath = 'C:\\Temp\\wesight-cowork-bin\\external_cli_windows_hide_init.cjs';
    const nodeOptions = appendNodeRequireOption(undefined, scriptPath);

    expect(appendNodeRequireOption(nodeOptions, scriptPath)).toBe(nodeOptions);
  });
});

describe('ExternalCliRuntimeAdapter Codex local config', () => {
  test('uses Agent engine command resolution for Claude Code on Windows', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-claude-cli-'));
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.APPDATA = tempDir;
      process.env.LOCALAPPDATA = path.join(tempDir, 'local');
      const claudeCmd = path.join(tempDir, 'npm', 'claude.cmd');
      fs.mkdirSync(path.dirname(claudeCmd), { recursive: true });
      fs.writeFileSync(claudeCmd, '@echo off\r\n', 'utf8');

      const { store } = createStore();
      const adapter = new ExternalCliRuntimeAdapter({
        engine: CoworkAgentEngine.ClaudeCode,
        store,
      });
      const internals = adapter as unknown as {
        resolveSpawnCommandSpec: (
          command: string,
          args: string[],
          env: Record<string, string | undefined>,
        ) => Promise<{
          command: string;
          args: string[];
          source: string;
          windowsVerbatimArguments?: boolean;
        }>;
      };

      const spawnSpec = await internals.resolveSpawnCommandSpec('claude', ['-p', 'hello'], {});

      expect(spawnSpec.command).toBe('cmd.exe');
      expect(spawnSpec.source).toBe('agent-engine-command-resolution');
      expect(spawnSpec.windowsVerbatimArguments).toBe(true);
      expect(spawnSpec.args.join(' ')).toContain(claudeCmd);
      expect(spawnSpec.args.join(' ')).toContain('hello');
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not override the local Codex CLI config with a selected provider', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
      getCurrentProvider: () => codexProvider,
    });
    const env: Record<string, string | undefined> = {};
    const internals = adapter as unknown as {
      getSelectedProviderForLocalCli: () => ExternalAgentProvider | null;
      prepareCodexHomeForExecMode: (
        env: Record<string, string | undefined>,
        provider: ExternalAgentProvider | null,
      ) => string | null;
      cleanupCodexHomeDir: (codexHomeDir: string | null) => void;
      buildCommandArgs: (
        cwd: string,
        prompt: string,
        imagePaths: string[],
        selectedProvider: ExternalAgentProvider | null,
        sessionTitle: string,
        cliSessionId: string | null,
      ) => string[];
    };

    const selectedProvider = internals.getSelectedProviderForLocalCli();
    expect(selectedProvider).toBeNull();
    const codexHomeDir = internals.prepareCodexHomeForExecMode(env, selectedProvider);
    expect(codexHomeDir).toBeNull();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();

    const args = internals.buildCommandArgs(
      'D:\\LHA\\wesight',
      'hello',
      [],
      selectedProvider,
      'session',
      null,
    );

    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).not.toContain('model_provider="ccswitch_tokln"');
    expect(args).not.toContain('model="gpt-5.5"');
  });

  test('does not resume Codex when WeSight model mode uses a temporary home', () => {
    const { store } = createStore(ExternalAgentConfigSource.WesightModel);
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const internals = adapter as unknown as {
      buildCommandArgs: (
        cwd: string,
        prompt: string,
        imagePaths: string[],
        selectedProvider: ExternalAgentProvider | null,
        sessionTitle: string,
        cliSessionId: string | null,
      ) => string[];
    };

    const args = internals.buildCommandArgs(
      'D:\\LHA\\wesight',
      'hello again',
      [],
      null,
      'session',
      '019e9cb9-32ce-7aa3-a54b-e98520aa4644',
    );

    expect(args).toContain('exec');
    expect(args).not.toContain('resume');
    expect(args).toContain('--cd');
    expect(args.at(-1)).toBe('hello again');
  });

  test('builds a Codex runtime config for WeSight model routing', () => {
    const { store } = createStore(ExternalAgentConfigSource.WesightModel);
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const internals = adapter as unknown as {
      buildCodexRuntimeConfig: (providerName: string, baseUrl: string, model: string) => string;
    };

    const config = internals.buildCodexRuntimeConfig(
      'deepseek',
      'https://api.deepseek.com',
      'deepseek-v4-flash',
    );
    expect(config).toContain('model_provider = "deepseek"');
    expect(config).toContain('model = "deepseek-v4-flash"');
    expect(config).toContain('base_url = "https://api.deepseek.com"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('requires_openai_auth = true');
  });

  test('does not fall back to local Codex config when WeSight routing is unsupported', () => {
    setStoreGetter(() => ({
      get: (key: string) => {
        if (key !== 'app_config') return null;
        return {
          model: {
            defaultModel: 'claude-sonnet-4-5-20250929',
            defaultModelProvider: ProviderName.Anthropic,
          },
          providers: {
            [ProviderName.Anthropic]: {
              enabled: true,
              apiKey: 'sk-test-anthropic',
              baseUrl: 'https://api.anthropic.com',
              apiFormat: 'anthropic',
              models: [{ id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' }],
            },
          },
        };
      },
    }) as never);
    try {
      const { store } = createStore(ExternalAgentConfigSource.WesightModel);
      const adapter = new ExternalCliRuntimeAdapter({
        engine: CoworkAgentEngine.Codex,
        store,
      });
      const internals = adapter as unknown as {
        prepareCodexHomeForExecMode: (
          env: Record<string, string | undefined>,
          provider: ExternalAgentProvider | null,
        ) => string | null;
      };

      expect(() => internals.prepareCodexHomeForExecMode({}, null)).toThrow(
        'Codex CLI could not use WeSight model config: Provider anthropic does not have an OpenAI-compatible endpoint for Codex CLI.',
      );
    } finally {
      setStoreGetter(() => null);
    }
  });

  test('summarizes the Codex server URL used for CLI startup', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-codex-log-'));
    try {
      fs.writeFileSync(
        path.join(tempDir, 'config.toml'),
        [
          'model_provider = "deepseek"',
          'model = "deepseek-v4-flash"',
          '',
          '[model_providers.deepseek]',
          'name = "deepseek"',
          'base_url = "http://127.0.0.1:56186/v1?api_key=secret-value"',
          'wire_api = "responses"',
          '',
        ].join('\n'),
        'utf8',
      );
      const { store } = createStore(ExternalAgentConfigSource.WesightModel);
      const adapter = new ExternalCliRuntimeAdapter({
        engine: CoworkAgentEngine.Codex,
        store,
      });
      const internals = adapter as unknown as {
        summarizeCodexConfigForLog: (
          env: Record<string, string | undefined>,
          codexHomeDir: string | null,
        ) => {
          serverUrl: string;
          modelProvider: string;
          model: string;
          wireApi: string;
        };
      };

      const summary = internals.summarizeCodexConfigForLog({}, tempDir);

      expect(summary.serverUrl).toBe('http://127.0.0.1:56186/v1?api_key=redacted');
      expect(summary.modelProvider).toBe('deepseek');
      expect(summary.model).toBe('deepseek-v4-flash');
      expect(summary.wireApi).toBe('responses');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('logs stderr tail content when a CLI process finishes', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const internals = adapter as unknown as {
      logCliProcessFinished: (
        active: {
          sessionId: string;
          cliSessionId: string | null;
          initialMessageCount: number;
          stderrTail: string;
        },
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => void;
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      internals.logCliProcessFinished(
        {
          sessionId: 'session-1',
          cliSessionId: 'thread-1',
          initialMessageCount: 0,
          stderrTail: 'upstream error: The deepseek-v4-flash model is not supported\n',
        },
        1,
        null,
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = logSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.stderrChars).toBe(61);
      expect(payload.stderrTail).toBe('upstream error: The deepseek-v4-flash model is not supported');
      expect(payload.stderrTailTruncated).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('retries Codex resume when rollout is missing and no assistant text was produced', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const active = {
      cliSessionId: 'thread-1',
      assistantMessageId: 'message-1',
      assistantContent: '',
      stderrTail: 'Error: thread/resume: thread/resume failed: no rollout found for thread id thread-1 (code -32600)',
    };
    const internals = adapter as unknown as {
      shouldRetryCodexWithoutResume: (active: typeof active, code: number | null) => boolean;
    };

    expect(internals.shouldRetryCodexWithoutResume(active, 1)).toBe(true);
    expect(internals.shouldRetryCodexWithoutResume({
      ...active,
      assistantContent: 'partial answer',
    }, 1)).toBe(false);
  });

  test('extracts assistant text from Codex CLI 0.136 JSONL events', () => {
    const { store, messages } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const internals = adapter as unknown as {
      handleCodexEvent: (active: {
        sessionId: string;
        cliSessionId: string | null;
        startedAt: number;
        assistantMessageId: string | null;
        assistantContent: string;
        assistantOutputStartedLogged: boolean;
        initialMessageCount: number;
        codexGeneratedImageIds: Set<string>;
      }, event: unknown) => void;
    };
    const active = {
      sessionId: 'session-1',
      cliSessionId: null,
      startedAt: Date.now(),
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      initialMessageCount: 0,
      codexGeneratedImageIds: new Set<string>(),
    };

    internals.handleCodexEvent(active, {
      type: 'thread.started',
      thread_id: '019e91b4-dedf-7653-987d-4177cab868a8',
    });
    internals.handleCodexEvent(active, {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: '我是 GPT-5 驱动的 Codex 编程助手。',
      },
    });

    expect(active.cliSessionId).toBe('019e91b4-dedf-7653-987d-4177cab868a8');
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('assistant');
    expect(messages[0].content).toBe('我是 GPT-5 驱动的 Codex 编程助手。');
    expect(messages[0].metadata).toEqual({ isStreaming: false, isFinal: true });
  });

  test('prefers the most complete Codex text field', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const internals = adapter as unknown as {
      extractCodexText: (value: unknown) => string | null;
    };

    expect(internals.extractCodexText({
      text: 'short',
      content: [
        { text: 'complete ' },
        { text: 'assistant text' },
      ],
    })).toBe('complete assistant text');
    expect(internals.extractCodexText({
      payload: {
        output: 'nested output',
      },
    })).toBe('nested output');
  });

  test('stops Codex turn failure before processing late output', () => {
    const { store, messages, session } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const errorSpy = vi.fn();
    adapter.on('error', errorSpy);
    const child = {
      kill: vi.fn(),
    };
    const active = {
      child,
      sessionId: 'session-1',
      cliSessionId: 'thread-1',
      startedAt: Date.now(),
      initialMessageCount: 0,
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      stderrTail: '',
      cliErrorMessage: null,
      sawEvent: true,
      sawClaudeVisibleOutput: false,
      startupTimer: null,
      noContentNoticeTimer: null,
      noContentTimeoutTimer: null,
      imagePaths: [],
      codexHomeDir: null,
      localClaudeConfig: null,
      configSource: ExternalAgentConfigSource.WesightModel,
      codexGeneratedImageIds: new Set<string>(),
      completedFromEvent: false,
    };
    const internals = adapter as unknown as {
      handleCodexEvent: (active: typeof active, event: unknown) => void;
      handleOutputLine: (active: typeof active, line: string) => void;
    };

    internals.handleCodexEvent(active, {
      type: 'turn.failed',
      message: 'Codex turn failed upstream.',
    });
    internals.handleOutputLine(active, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'late output',
      },
    }));

    expect(active.completedFromEvent).toBe(true);
    expect(session.status).toBe('error');
    expect(errorSpy).toHaveBeenCalledWith('session-1', 'Codex turn failed upstream.');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(messages).toHaveLength(0);
  });

  test('ignores Codex image generation events without an id', () => {
    const { store, messages } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const active = {
      sessionId: 'session-1',
      codexGeneratedImageIds: new Set<string>(),
    };
    const internals = adapter as unknown as {
      handleCodexEventMessage: (active: typeof active, payload: Record<string, unknown>) => void;
    };

    internals.handleCodexEventMessage(active, {
      type: 'image_generation_end',
    });

    expect(active.codexGeneratedImageIds.size).toBe(0);
    expect(messages).toHaveLength(0);
  });

  test('releases Codex session lock before emitting complete from turn event', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const completeSpy = vi.fn();
    adapter.on('complete', completeSpy);
    const child = {
      kill: vi.fn(),
    };
    const active = {
      child,
      sessionId: 'session-1',
      cliSessionId: 'thread-1',
      startedAt: Date.now(),
      initialMessageCount: 0,
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      stderrTail: '',
      cliErrorMessage: null,
      sawEvent: true,
      sawClaudeVisibleOutput: false,
      startupTimer: null,
      noContentNoticeTimer: null,
      noContentTimeoutTimer: null,
      imagePaths: [],
      codexHomeDir: null,
      localClaudeConfig: null,
      configSource: ExternalAgentConfigSource.WesightModel,
      codexGeneratedImageIds: new Set<string>(),
      completedFromEvent: false,
    };
    const internals = adapter as unknown as {
      activeSessions: Map<string, typeof active>;
      completeCodexSessionFromEvent: (active: typeof active) => void;
    };
    internals.activeSessions.set('session-1', active);

    internals.completeCodexSessionFromEvent(active);

    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(completeSpy).toHaveBeenCalledWith('session-1', 'thread-1');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('restores Claude Code runtime settings when releasing an active session', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-claude-adapter-release-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-local',
          ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
          ANTHROPIC_MODEL: 'MiniMax-M3.0',
        },
      }),
      'utf8',
    );

    const { store } = createStore(ExternalAgentConfigSource.WesightModel);
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.ClaudeCode,
      store,
    });
    const lease = acquireWesightClaudeRuntimeConfig({
      apiKey: 'sk-wesight',
      baseURL: 'http://127.0.0.1:57057',
      model: 'deepseek-v4-flash',
      apiType: 'openai',
    }, settingsPath);
    const active = {
      sessionId: 'session-1',
      claudeRuntimeConfigLease: lease,
    };
    const internals = adapter as unknown as {
      activeSessions: Map<string, typeof active>;
      releaseActiveSession: (active: typeof active) => void;
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      internals.activeSessions.set('session-1', active);
      internals.releaseActiveSession(active);

      expect(adapter.isSessionActive('session-1')).toBe(false);
      const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(restored).toEqual({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-local',
          ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
          ANTHROPIC_MODEL: 'MiniMax-M3.0',
        },
      });
      expect(active.claudeRuntimeConfigLease).toBeNull();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ignores late Codex output after turn completion', () => {
    const { store, messages } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const active = {
      sessionId: 'session-1',
      cliSessionId: 'thread-1',
      startedAt: Date.now(),
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      initialMessageCount: 0,
      completedFromEvent: true,
      codexGeneratedImageIds: new Set<string>(),
    };
    const internals = adapter as unknown as {
      handleOutputLine: (active: typeof active, line: string) => void;
    };

    internals.handleOutputLine(active, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'late output',
      },
    }));

    expect(messages).toHaveLength(0);
  });

  test('logs when external CLI assistant output starts', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const active = {
      sessionId: 'session-1',
      cliSessionId: 'thread-1',
      startedAt: Date.now() - 1200,
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      initialMessageCount: 0,
      configSource: ExternalAgentConfigSource.WesightModel,
    };
    const internals = adapter as unknown as {
      appendAssistant: (active: typeof active, delta: string) => void;
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      internals.appendAssistant(active, 'hello');
      internals.appendAssistant(active, ' world');

      const outputStartedLogs = logSpy.mock.calls.filter((call) => (
        call[0] === '[ExternalCliRuntimeAdapter] CLI assistant output started.'
      ));
      expect(outputStartedLogs).toHaveLength(1);
      expect(outputStartedLogs[0][1]).toMatchObject({
        engine: 'Codex CLI',
        sessionId: 'session-1',
        cliSessionId: 'thread-1',
        configSource: ExternalAgentConfigSource.WesightModel,
        outputChars: 5,
        isFinal: false,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('redacts Claude Code stream text from log summaries', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.ClaudeCode,
      store,
    });
    const internals = adapter as unknown as {
      summarizeClaudeCliEvent: (event: Record<string, unknown>) => Record<string, unknown>;
    };

    const summary = internals.summarizeClaudeCliEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'private assistant response text',
        },
      },
    });

    expect(JSON.stringify(summary)).not.toContain('private assistant response text');
    expect(summary).toMatchObject({
      type: 'stream_event',
      streamType: 'content_block_delta',
      deltaType: 'text_delta',
      textChars: 31,
    });
  });

  test('does not log every Claude Code stream event', () => {
    const { store } = createStore();
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.ClaudeCode,
      store,
    });
    const internals = adapter as unknown as {
      handleClaudeCliEvent: (active: {
        sessionId: string;
        cliSessionId: string | null;
        startedAt: number;
        assistantMessageId: string | null;
        assistantContent: string;
        assistantOutputStartedLogged: boolean;
        initialMessageCount: number;
      }, event: unknown) => void;
    };
    const active = {
      sessionId: 'session-1',
      cliSessionId: null,
      startedAt: Date.now(),
      assistantMessageId: null,
      assistantContent: '',
      assistantOutputStartedLogged: false,
      initialMessageCount: 0,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      internals.handleClaudeCliEvent(active, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: 'streamed text',
          },
        },
      });
      internals.handleClaudeCliEvent(active, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: ' more text',
          },
        },
      });

      const outputStartedLogs = logSpy.mock.calls.filter((call) => (
        call[0] === '[ExternalCliRuntimeAdapter] CLI assistant output started.'
      ));
      expect(outputStartedLogs).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});
