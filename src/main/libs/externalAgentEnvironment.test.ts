import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { getExternalAgentEnvironmentSnapshot, resolveCliCommand, summarizeCliAuthStatus } from './externalAgentEnvironment';

let tempDir = '';
let originalPath = '';
let originalOpenAiKey: string | undefined;
let originalAppData: string | undefined;
let originalLocalAppData: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const writeExecutable = (name: string, script: string): string => {
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, script, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-agent-env-'));
  originalPath = process.env.PATH ?? '';
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  originalAppData = process.env.APPDATA;
  originalLocalAppData = process.env.LOCALAPPDATA;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;
  process.env.APPDATA = path.join(tempDir, 'appdata');
  process.env.LOCALAPPDATA = path.join(tempDir, 'localappdata');
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
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

test('probes CLI commands asynchronously and isolates version timeouts', async () => {
  let claudePath: string;
  if (process.platform === 'win32') {
    claudePath = path.join(process.env.APPDATA || tempDir, 'npm', 'claude.cmd');
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, '@echo off\r\necho claude-test 1.0.0\r\n', 'utf8');
  } else {
    claudePath = writeExecutable('claude', '#!/bin/sh\necho "claude-test 1.0.0"\n');
  }
  writeExecutable(
    'grok',
    process.platform === 'win32'
      ? '@echo off\r\npowershell.exe -NoProfile -Command "Start-Sleep -Seconds 2"\r\n'
      : '#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 2; fi\n',
  );

  const { snapshot, report } = await getExternalAgentEnvironmentSnapshot({
    appTypes: ['claude', 'grok'],
    includeUserShellPath: false,
    versionProbeTimeoutMsByAppType: {
      claude: 1500,
      grok: 300,
    },
  });
  const claude = snapshot.engines.find(engine => engine.appType === 'claude');
  const grok = snapshot.engines.find(engine => engine.appType === 'grok');
  const grokMetric = report.metrics.find(metric => metric.command === 'grok');

  expect(claude).toMatchObject({
    found: true,
    path: claudePath,
    version: 'claude-test 1.0.0',
  });
  expect(claude?.checking).toBeUndefined();
  expect(grok).toMatchObject({
    found: true,
    version: null,
  });
  expect(grokMetric).toMatchObject({
    command: 'grok',
    found: true,
    timedOut: true,
  });
});

test('detects Codex local auth from auth.json', () => {
  const configDir = path.join(tempDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const primaryConfigPath = path.join(configDir, 'config.toml');
  const authPath = path.join(configDir, 'auth.json');
  fs.writeFileSync(primaryConfigPath, 'model_provider = "openai"\nmodel = "gpt-5.5"\n', 'utf8');
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-local-codex' }), 'utf8');

  const result = summarizeCliAuthStatus('codex', {
    configDir,
    primaryConfigPath,
    secondaryConfigPaths: [authPath],
    configExists: true,
    currentProviderId: 'openai',
    currentProviderName: 'openai',
    providerCount: 1,
  });

  expect(result).toMatchObject({
    authStatus: 'logged_in',
    authMessage: 'file',
  });
});

test('does not treat WeSight placeholders as local CLI credentials', () => {
  const configDir = path.join(tempDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  const primaryConfigPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(primaryConfigPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: '${WESIGHT_APIKEY_ACTIVE_PROVIDER}',
    },
  }), 'utf8');

  const result = summarizeCliAuthStatus('claude', {
    configDir,
    primaryConfigPath,
    secondaryConfigPaths: [],
    configExists: true,
    currentProviderId: null,
    currentProviderName: null,
    providerCount: 0,
  });

  expect(result.authStatus).toBe('logged_out');
});

test('summarizes native Claude Code settings when cc-switch is absent', async () => {
  writeExecutable(
    'claude',
    process.platform === 'win32'
      ? '@echo off\r\necho claude-test 1.0.0\r\n'
      : '#!/bin/sh\necho "claude-test 1.0.0"\n',
  );
  const configDir = path.join(tempDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-local-claude',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
    },
  }), 'utf8');

  const { snapshot } = await getExternalAgentEnvironmentSnapshot({
    appTypes: ['claude'],
    includeUserShellPath: false,
  });

  expect(snapshot.engines[0]?.config).toMatchObject({
    currentProviderId: 'local-live',
    currentProviderName: 'Local Claude Code',
    providerCount: 1,
  });
  expect(snapshot.engines[0]?.authStatus).toBe('logged_in');
});

test('summarizes native Codex model providers when cc-switch is absent', async () => {
  writeExecutable(
    'codex',
    process.platform === 'win32'
      ? '@echo off\r\necho codex-test 1.0.0\r\n'
      : '#!/bin/sh\necho "codex-test 1.0.0"\n',
  );
  const configDir = path.join(tempDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.toml'), [
    'model_provider = "local_codex"',
    'model = "gpt-5.5"',
    '',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/v1"',
    '',
    '[model_providers.local_codex]',
    'name = "Local Codex"',
    'base_url = "http://127.0.0.1:4000/v1"',
    '',
    '[model_providers.minimax]',
    'name = "MiniMax"',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'sk-local-codex',
  }), 'utf8');

  const { snapshot } = await getExternalAgentEnvironmentSnapshot({
    appTypes: ['codex'],
    includeUserShellPath: false,
  });

  expect(snapshot.engines[0]?.config).toMatchObject({
    currentProviderId: 'local_codex',
    currentProviderName: 'Local Codex',
    providerCount: 3,
  });
  expect(snapshot.engines[0]?.authStatus).toBe('logged_in');
});

test('limits probes to requested app types', async () => {
  const codexPath = writeExecutable(
    'codex',
    process.platform === 'win32'
      ? '@echo off\r\necho codex-test 1.0.0\r\n'
      : '#!/bin/sh\necho "codex-test 1.0.0"\n',
  );

  const { snapshot, report } = await getExternalAgentEnvironmentSnapshot({ appTypes: ['codex'] });

  expect(snapshot.engines).toHaveLength(1);
  expect(snapshot.engines[0]).toMatchObject({
    appType: 'codex',
    found: true,
    path: codexPath,
    version: 'codex-test 1.0.0',
  });
  expect(report.metrics.map(metric => metric.command)).toEqual(['codex']);
});

test('resolves native Windows Claude Code installs before PATH lookup', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  process.env.LOCALAPPDATA = tempDir;
  const claudePath = path.join(tempDir, 'Programs', 'Claude', 'claude.exe');
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, '', 'utf8');

  const resolution = await resolveCliCommand('claude', {
    includeUserShellPath: false,
    commandProbeTimeoutMs: 100,
  });

  expect(resolution).toMatchObject({
    found: true,
    path: claudePath,
    error: null,
  });
});
