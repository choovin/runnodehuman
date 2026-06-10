/**
 * wesightConfigFile.ts
 *
 * File-IO helpers extracted from c3e09f4's externalAgentConfigSync.ts after
 * merge d9d8d55 dropped 983 lines from that file. We re-export the 3
 * functions that externalAgentProviderStore.ts imports, plus the 4 private
 * helpers and 2 private constants they need to function.
 *
 * These functions back up and (when content actually changes) atomically
 * rewrite a config file. The "with backup if changed" pattern keeps a
 * `.wesight-backups/<name>.<timestamp>.<pid>.<hrtime>.bak` copy under the
 * same directory as the file (retention: 20 most-recent).
 *
 * Why a separate file: keeping this small self-contained surface makes it
 * obvious that no other module depends on c3e09f4's broader refactor
 * (cowork pivot, deepSeekTui, grokBuild, hermesConfig, etc.). The
 * `c3e09f4-design-analysis.md` doc explicitly recommended NOT bringing
 * in c3e09f4 wholesale.
 */

import fs from 'fs';
import path from 'path';

// ----------------------------------------------------------------------------
// Private constants
// ----------------------------------------------------------------------------

const WESIGHT_CONFIG_BACKUP_DIR = '.wesight-backups';
const WESIGHT_CONFIG_BACKUP_RECENT_RETENTION = 20;
const WESIGHT_MANAGED_META_KEY = '__wesight_managed';

// ----------------------------------------------------------------------------
// Private IO helpers
// ----------------------------------------------------------------------------

const ensureParentDir = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const atomicWrite = (filePath: string, content: string): void => {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
};

const pruneWesightConfigFileBackups = (backupsDir: string, baseName: string): void => {
  const prefix = `${baseName}.`;
  const entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.bak'))
    .map((entry) => {
      const backupPath = path.join(backupsDir, entry.name);
      return {
        name: entry.name,
        path: backupPath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length <= WESIGHT_CONFIG_BACKUP_RECENT_RETENTION + 1) {
    return;
  }

  const firstBackup = entries[0];
  const recentBackups = entries
    .slice(1)
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, WESIGHT_CONFIG_BACKUP_RECENT_RETENTION);
  const retained = new Set([firstBackup.path, ...recentBackups.map((entry) => entry.path)]);

  for (const entry of entries) {
    if (retained.has(entry.path)) continue;
    fs.unlinkSync(entry.path);
  }
};

export const createWesightConfigFileBackup = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupsDir = path.join(path.dirname(filePath), WESIGHT_CONFIG_BACKUP_DIR);
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = process.hrtime.bigint().toString(36);
  const backupPath = path.join(backupsDir, `${path.basename(filePath)}.${timestamp}.${process.pid}.${uniqueSuffix}.bak`);
  fs.copyFileSync(filePath, backupPath);
  pruneWesightConfigFileBackups(backupsDir, path.basename(filePath));
  return backupPath;
};

// ----------------------------------------------------------------------------
// Public IO API (the 3 missing functions externalAgentProviderStore.ts needs)
// ----------------------------------------------------------------------------

/**
 * Write text content to `filePath`, but only if it actually differs from
 * the existing content. When overwriting an existing file, create a
 * timestamped backup copy under `<dir>/.wesight-backups/` first.
 *
 * Returns `true` if a write happened, `false` if the content was
 * already up-to-date (or the file did not exist with the same content).
 */
export const writeTextFileWithBackupIfChanged = (filePath: string, content: string): boolean => {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === content) {
    return false;
  }
  if (existing !== null) {
    createWesightConfigFileBackup(filePath);
  }
  atomicWrite(filePath, content);
  return true;
};

/**
 * Serialize `value` as pretty JSON (2-space indent, trailing newline) and
 * write via `writeTextFileWithBackupIfChanged`.
 */
export const writeJsonObjectWithBackupIfChanged = (
  filePath: string,
  value: Record<string, unknown>,
): boolean => {
  return writeTextFileWithBackupIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

// ----------------------------------------------------------------------------
// removeWesightManagedClaudeSettings
//
// Strips WeSight-managed Claude Code env keys from a `~/.claude/settings.json`
// blob, restoring the values that existed before WeSight overrode them.
// The "before" snapshot lives at `__wesight_managed.claudeCode.{envKeys,
// createdEnvKeys, originalEnv}`. If the snapshot is recoverable, the
// original env values are restored; otherwise the WeSight-managed env
// keys are deleted (treating them as placeholders).
// ----------------------------------------------------------------------------

const getNestedRecord = (value: unknown, key: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
};

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
};

const isWesightPlaceholder = (value: unknown): boolean => {
  return typeof value === 'string'
    && /^\$\{(?:WESIGHT|LOBSTER)_[A-Z0-9_]+\}$/.test(value.trim());
};

const removeClaudeManagedMetadata = (
  existingSettings: Record<string, unknown>,
  existingManaged: Record<string, unknown>,
  existingClaude: Record<string, unknown>,
  env?: Record<string, unknown>,
): Record<string, unknown> => {
  const claudeManaged = { ...existingClaude };
  delete claudeManaged.envKeys;
  delete claudeManaged.createdEnvKeys;
  delete claudeManaged.originalEnv;
  delete claudeManaged.credentialKey;

  const managed = { ...existingManaged };
  if (Object.keys(claudeManaged).length > 0) {
    managed.claudeCode = claudeManaged;
  } else {
    delete managed.claudeCode;
  }

  const next = { ...existingSettings };
  if (env) {
    if (Object.keys(env).length > 0) {
      next.env = env;
    } else {
      delete next.env;
    }
  }
  if (Object.keys(managed).length > 0) {
    next[WESIGHT_MANAGED_META_KEY] = managed;
  } else {
    delete next[WESIGHT_MANAGED_META_KEY];
  }
  return next;
};

export const removeWesightManagedClaudeSettings = (
  existingSettings: Record<string, unknown>,
): Record<string, unknown> => {
  const existingManaged = getNestedRecord(existingSettings, WESIGHT_MANAGED_META_KEY);
  const existingClaude = getNestedRecord(existingManaged, 'claudeCode');
  const previousEnvKeys = getStringArray(existingClaude.envKeys);
  const previousCreatedEnvKeys = getStringArray(existingClaude.createdEnvKeys);
  const previousOriginalEnv = getNestedRecord(existingClaude, 'originalEnv');
  const hasRecoverableSnapshot = Object.keys(previousOriginalEnv).length > 0 || previousCreatedEnvKeys.length > 0;

  if (previousEnvKeys.length === 0) {
    return existingSettings;
  }

  if (!hasRecoverableSnapshot) {
    // eslint-disable-next-line no-console
    console.warn('[WesightConfigFile] found legacy Claude Code managed marker without original environment snapshot; preserving local environment values.');
    return removeClaudeManagedMetadata(existingSettings, existingManaged, existingClaude);
  }

  const env = { ...getNestedRecord(existingSettings, 'env') };
  for (const key of previousEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(previousOriginalEnv, key)) {
      env[key] = previousOriginalEnv[key];
    } else if (previousCreatedEnvKeys.includes(key) || isWesightPlaceholder(env[key])) {
      delete env[key];
    }
  }

  return removeClaudeManagedMetadata(existingSettings, existingManaged, existingClaude, env);
};
