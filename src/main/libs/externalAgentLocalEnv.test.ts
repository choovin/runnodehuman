import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyLocalClaudeCodeEnvForPrintMode,
  type LocalClaudeCodeProviderConfig,
  resolveLocalClaudeCodeConfigSnapshot,
} from './externalAgentLocalEnv';

let tempDir = '';
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const writeClaudeSettings = (settings: Record<string, unknown>): void => {
  const configDir = path.join(tempDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings), 'utf8');
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-local-claude-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('local Claude Code environment', () => {
  test('falls back to native Claude settings when selected provider is metadata only', () => {
    writeClaudeSettings({
      env: {
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
      },
    });
    const emptyOfficialProvider: LocalClaudeCodeProviderConfig = {
      name: 'Claude Official',
      settingsConfig: {
        env: {},
        __wesightProviderMeta: {
          commonConfigEnabled: true,
        },
      },
    };
    const env: Record<string, string | undefined> = {};

    const loaded = applyLocalClaudeCodeEnvForPrintMode(env, emptyOfficialProvider);
    const snapshot = resolveLocalClaudeCodeConfigSnapshot(emptyOfficialProvider);

    expect(loaded).toMatchObject({
      sourceName: 'Claude Code settings',
      model: 'claude-sonnet-4-5',
    });
    expect(snapshot).toMatchObject({
      sourceType: 'settings',
      model: 'claude-sonnet-4-5',
    });
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-5');
  });

  test('uses the top-level Claude model when env model fields are absent', () => {
    writeClaudeSettings({
      model: 'claude-opus-4-5',
      env: {},
    });
    const env: Record<string, string | undefined> = {};

    const loaded = applyLocalClaudeCodeEnvForPrintMode(env, null);

    expect(loaded).toMatchObject({
      sourceName: 'Claude Code settings',
      model: 'claude-opus-4-5',
    });
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-5');
  });

  test('keeps a selected provider when it contains a real Claude model', () => {
    writeClaudeSettings({
      env: {
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      },
    });
    const provider: LocalClaudeCodeProviderConfig = {
      name: 'Kimi For Coding',
      settingsConfig: {
        env: {
          ANTHROPIC_MODEL: 'kimi-k2.5',
          ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
        },
      },
    };
    const env: Record<string, string | undefined> = {};

    const loaded = applyLocalClaudeCodeEnvForPrintMode(env, provider);
    const snapshot = resolveLocalClaudeCodeConfigSnapshot(provider);

    expect(loaded).toMatchObject({
      sourceName: 'Kimi For Coding',
      model: 'kimi-k2.5',
      baseUrl: 'https://api.moonshot.cn/anthropic',
    });
    expect(snapshot).toMatchObject({
      sourceType: 'selected_provider',
      model: 'kimi-k2.5',
    });
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k2.5');
  });
});
