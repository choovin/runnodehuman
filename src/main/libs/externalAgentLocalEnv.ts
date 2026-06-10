import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveRawApiConfig } from './claudeSettings';

type LocalClaudeConfig = {
  sourceType: 'selected_provider' | 'cc_switch' | 'settings';
  sourceName: string;
  configPath?: string;
  root: Record<string, unknown>;
  env: Record<string, unknown>;
  meta: Record<string, unknown>;
};

export type LocalClaudeCodeProviderConfig = {
  name: string;
  settingsConfig: Record<string, unknown>;
};

export type LocalClaudeCodeEnvLoadResult = {
  sourceName: string;
  baseUrl: string;
  model: string;
  credentialSource: string | null;
};

export type LocalClaudeCodeConfigSnapshot = LocalClaudeCodeEnvLoadResult & {
  sourceType: LocalClaudeConfig['sourceType'];
  configPath?: string;
};

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;
type ClaudeEnvKey = typeof CLAUDE_ENV_KEYS[number];

const CLAUDE_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const satisfies readonly ClaudeEnvKey[];

const INTERNAL_PROVIDER_META_KEY = '__wesightProviderMeta';

const homeDir = (): string => os.homedir();

const readJsonObject = (filePath: string): Record<string, unknown> | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const getNestedRecord = (value: unknown, key: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
};

const getString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const maskSecretForLog = (value: unknown): string => {
  const text = getString(value);
  if (!text) return '(not set)';
  if (text.length <= 10) return `<redacted:${text.length}>`;
  return `${text.slice(0, 5)}...${text.slice(-5)} (${text.length})`;
};

const looksLikePlaceholder = (value: unknown): boolean => {
  return /^\$\{[^}]+\}$/.test(getString(value));
};

const isClaudeSecretEnvKey = (key: ClaudeEnvKey): boolean => (
  key === 'ANTHROPIC_AUTH_TOKEN' || key === 'ANTHROPIC_API_KEY'
);

const normalizeBaseUrlForMatch = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.toLowerCase();
  }
};

const baseUrlsMatch = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeBaseUrlForMatch(left);
  const normalizedRight = normalizeBaseUrlForMatch(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
};

const readCurrentCcSwitchClaudeConfig = (): LocalClaudeConfig | null => {
  const appDir = path.join(homeDir(), '.cc-switch');
  const settingsPath = path.join(appDir, 'settings.json');
  const dbPath = path.join(appDir, 'cc-switch.db');
  if (!fs.existsSync(dbPath)) return null;

  const settings = readJsonObject(settingsPath) ?? {};
  const currentProviderId = getString(settings.currentProviderClaude)
    || getString(settings.current_provider_claude);
  let db: Database.Database | null = null;

  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const provider = currentProviderId
      ? db
        .prepare('SELECT id, name, settings_config, meta FROM providers WHERE app_type = ? AND id = ? LIMIT 1')
        .get('claude', currentProviderId) as { id?: string; name?: string; settings_config?: string; meta?: string } | undefined
      : db
        .prepare('SELECT id, name, settings_config, meta FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 1')
        .get('claude') as { id?: string; name?: string; settings_config?: string; meta?: string } | undefined;
    if (!provider) return null;

    const settingsConfig = parseJsonObject(provider.settings_config);
    return {
      sourceType: 'cc_switch',
      sourceName: provider.name ? `cc-switch provider: ${provider.name}` : 'cc-switch provider',
      configPath: `${dbPath}${provider.id ? `#${provider.id}` : ''}`,
      root: settingsConfig,
      env: getNestedRecord(settingsConfig, 'env'),
      meta: parseJsonObject(provider.meta),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors from a read-only local config snapshot.
    }
  }
};

const readClaudeSettingsConfig = (): LocalClaudeConfig | null => {
  const settingsPath = path.join(homeDir(), '.claude', 'settings.json');
  const settings = readJsonObject(settingsPath);
  if (!settings) return null;
  return {
    sourceType: 'settings',
    sourceName: 'Claude Code settings',
    configPath: settingsPath,
    root: settings,
    env: getNestedRecord(settings, 'env'),
    meta: {},
  };
};

export const getClaudeCodeModelFromSettingsConfig = (
  settingsConfig: Record<string, unknown>,
): string => {
  const env = getNestedRecord(settingsConfig, 'env');
  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    const value = getString(env[key]);
    if (value && !looksLikePlaceholder(value)) {
      return value;
    }
  }
  const topLevelModel = getString(settingsConfig.model);
  if (topLevelModel && !looksLikePlaceholder(topLevelModel)) {
    return topLevelModel;
  }
  return '';
};

const getClaudeCodeBaseUrlFromSettingsConfig = (
  settingsConfig: Record<string, unknown>,
): string => {
  const value = getString(getNestedRecord(settingsConfig, 'env').ANTHROPIC_BASE_URL);
  return value && !looksLikePlaceholder(value) ? value : '';
};

const hasUsableLocalClaudeConfig = (config: LocalClaudeConfig): boolean => {
  if (getClaudeCodeModelFromSettingsConfig(config.root)) return true;
  if (getClaudeCodeBaseUrlFromSettingsConfig(config.root)) return true;
  for (const key of CLAUDE_ENV_KEYS) {
    const value = getString(config.env[key]);
    if (value && !looksLikePlaceholder(value)) {
      return true;
    }
  }
  return false;
};

const buildLocalClaudeConfigFromProvider = (
  provider: LocalClaudeCodeProviderConfig | null | undefined,
): LocalClaudeConfig | null => {
  if (!provider) return null;
  const config = {
    sourceType: 'selected_provider' as const,
    sourceName: provider.name,
    configPath: 'WeSight selected local provider',
    root: provider.settingsConfig,
    env: getNestedRecord(provider.settingsConfig, 'env'),
    meta: getNestedRecord(provider.settingsConfig, INTERNAL_PROVIDER_META_KEY),
  };
  return hasUsableLocalClaudeConfig(config) ? config : null;
};

const resolvePreferredLocalClaudeConfig = (
  provider?: LocalClaudeCodeProviderConfig | null,
): LocalClaudeConfig | null => {
  const configs = [
    buildLocalClaudeConfigFromProvider(provider),
    readCurrentCcSwitchClaudeConfig(),
    readClaudeSettingsConfig(),
  ].filter((config): config is LocalClaudeConfig => Boolean(config));
  return configs.find(hasUsableLocalClaudeConfig) ?? null;
};

const readLocalClaudeConfigsForDiagnostics = (
  provider?: LocalClaudeCodeProviderConfig | null,
): LocalClaudeConfig[] => {
  const configs = [
    buildLocalClaudeConfigFromProvider(provider),
    readCurrentCcSwitchClaudeConfig(),
    readClaudeSettingsConfig(),
  ].filter((config): config is LocalClaudeConfig => Boolean(config));

  const seen = new Set<string>();
  return configs.filter((config) => {
    const fingerprint = `${config.sourceName}\n${config.configPath ?? ''}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
};

export const resolveLocalClaudeCodeConfigSnapshot = (
  provider?: LocalClaudeCodeProviderConfig | null,
): LocalClaudeCodeConfigSnapshot | null => {
  const localConfig = resolvePreferredLocalClaudeConfig(provider);
  if (!localConfig) return null;
  const credential = pickCredentialForPrintMode(localConfig.env, localConfig.meta);
  return {
    sourceType: localConfig.sourceType,
    sourceName: localConfig.sourceName,
    configPath: localConfig.configPath,
    baseUrl: getClaudeCodeBaseUrlFromSettingsConfig(localConfig.root),
    model: getClaudeCodeModelFromSettingsConfig(localConfig.root),
    credentialSource: credential?.source ?? null,
  };
};

const summarizeClaudeEnv = (env: Record<string, unknown>): Record<ClaudeEnvKey, string> => {
  const summary = {} as Record<ClaudeEnvKey, string>;
  for (const key of CLAUDE_ENV_KEYS) {
    const value = getString(env[key]);
    if (!value) {
      summary[key] = '(not set)';
      continue;
    }
    summary[key] = isClaudeSecretEnvKey(key) ? maskSecretForLog(value) : value;
  }
  return summary;
};

const collectClaudeEnvConflicts = (
  childEnv: Record<string, string | undefined>,
  localEnv: Record<string, unknown>,
): string[] => {
  const conflicts: string[] = [];
  for (const key of CLAUDE_ENV_KEYS) {
    const childValue = getString(childEnv[key]);
    const localValue = getString(localEnv[key]);
    if (!childValue || !localValue || childValue === localValue) {
      continue;
    }
    const childDisplay = isClaudeSecretEnvKey(key) ? maskSecretForLog(childValue) : childValue;
    const localDisplay = isClaudeSecretEnvKey(key) ? maskSecretForLog(localValue) : localValue;
    conflicts.push(`${key}: child=${childDisplay} local=${localDisplay}`);
  }
  return conflicts;
};

export const buildClaudeCodeConfigDiagnostics = (
  childEnv: Record<string, string | undefined>,
  provider?: LocalClaudeCodeProviderConfig | null,
): Record<string, unknown> => {
  const localConfigs = readLocalClaudeConfigsForDiagnostics(provider).map((config) => ({
    source: config.sourceName,
    configPath: config.configPath ?? '(unknown)',
    env: summarizeClaudeEnv(config.env),
    conflictsWithChildEnv: collectClaudeEnvConflicts(childEnv, config.env),
  }));

  return {
    childEnv: summarizeClaudeEnv(childEnv),
    localConfigs,
  };
};

const pickCredentialForPrintMode = (
  localEnv: Record<string, unknown>,
  meta: Record<string, unknown>,
): { value: string; source: string } | null => {
  const rawApiKey = getString(localEnv.ANTHROPIC_API_KEY);
  const rawAuthToken = getString(localEnv.ANTHROPIC_AUTH_TOKEN);
  const apiKey = rawApiKey && !looksLikePlaceholder(rawApiKey) ? rawApiKey : '';
  const authToken = rawAuthToken && !looksLikePlaceholder(rawAuthToken) ? rawAuthToken : '';
  if (!apiKey && !authToken) return null;
  if (apiKey && !authToken) return { value: apiKey, source: 'ANTHROPIC_API_KEY' };
  if (!apiKey && authToken) return { value: authToken, source: 'ANTHROPIC_AUTH_TOKEN' };
  if (apiKey === authToken) return { value: apiKey, source: 'ANTHROPIC_API_KEY' };

  const localBaseUrl = getString(localEnv.ANTHROPIC_BASE_URL);
  const wesightConfig = resolveRawApiConfig().config;
  const apiKeyLooksInjected = Boolean(
    wesightConfig?.apiKey
    && apiKey === wesightConfig.apiKey
    && !baseUrlsMatch(localBaseUrl, wesightConfig.baseURL),
  );
  const authTokenLooksInjected = Boolean(
    wesightConfig?.apiKey
    && authToken === wesightConfig.apiKey
    && !baseUrlsMatch(localBaseUrl, wesightConfig.baseURL),
  );

  if (apiKeyLooksInjected && !authTokenLooksInjected) {
    return { value: authToken, source: 'ANTHROPIC_AUTH_TOKEN' };
  }
  if (authTokenLooksInjected && !apiKeyLooksInjected) {
    return { value: apiKey, source: 'ANTHROPIC_API_KEY' };
  }

  const configuredField = getString(meta.apiKeyField);
  if (configuredField === 'ANTHROPIC_AUTH_TOKEN') {
    return { value: authToken, source: 'ANTHROPIC_AUTH_TOKEN' };
  }
  return { value: apiKey, source: 'ANTHROPIC_API_KEY' };
};

export const applyLocalClaudeCodeEnvForPrintMode = (
  env: Record<string, string | undefined>,
  provider?: LocalClaudeCodeProviderConfig | null,
): LocalClaudeCodeEnvLoadResult | null => {
  const localConfig = resolvePreferredLocalClaudeConfig(provider);
  if (!localConfig) return null;

  for (const key of CLAUDE_ENV_KEYS) {
    const value = getString(localConfig.env[key]);
    if (value && !looksLikePlaceholder(value)) {
      env[key] = value;
    }
  }
  const resolvedModel = getClaudeCodeModelFromSettingsConfig(localConfig.root);
  if (resolvedModel && !CLAUDE_MODEL_ENV_KEYS.some((key) => getString(localConfig.env[key]))) {
    env.ANTHROPIC_MODEL = resolvedModel;
  }

  const credential = pickCredentialForPrintMode(localConfig.env, localConfig.meta);
  if (credential) {
    // Claude Code --print currently reports ANTHROPIC_API_KEY as the key source.
    // Mirror the selected local credential into both aliases for this subprocess only.
    env.ANTHROPIC_API_KEY = credential.value;
    env.ANTHROPIC_AUTH_TOKEN = credential.value;
  }

  console.log('[ExternalAgentLocalEnv] loaded local Claude Code config.', {
    source: localConfig.sourceName,
    baseUrl: getClaudeCodeBaseUrlFromSettingsConfig(localConfig.root) || '(not set)',
    model: resolvedModel || '(not set)',
    defaultSonnetModel: getString(localConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL) || '(not set)',
    credentialSource: credential?.source ?? '(not set)',
    anthropicApiKey: maskSecretForLog(env.ANTHROPIC_API_KEY),
    anthropicAuthToken: maskSecretForLog(env.ANTHROPIC_AUTH_TOKEN),
    apiKeyLooksLikePlaceholder: looksLikePlaceholder(env.ANTHROPIC_API_KEY),
    authTokenLooksLikePlaceholder: looksLikePlaceholder(env.ANTHROPIC_AUTH_TOKEN),
  });
  return {
    sourceName: localConfig.sourceName,
    baseUrl: getClaudeCodeBaseUrlFromSettingsConfig(localConfig.root),
    model: resolvedModel,
    credentialSource: credential?.source ?? null,
  };
};
