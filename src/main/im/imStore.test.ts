import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, expect, test } from 'vitest';

import { FeishuEngineKey } from '../../shared/im/constants';
import { IMStore } from './imStore';
import { DEFAULT_FEISHU_OPENCLAW_CONFIG, type FeishuInstanceConfig } from './types';

const dbs: Database.Database[] = [];

const createStore = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  return {
    db,
    store: new IMStore(db),
  };
};

const createFeishuInstance = (
  instanceId: string,
  appId: string,
): FeishuInstanceConfig => ({
  ...DEFAULT_FEISHU_OPENCLAW_CONFIG,
  instanceId,
  instanceName: instanceId,
  appId,
  appSecret: `${appId}-secret`,
});

afterEach(() => {
  while (dbs.length > 0) {
    dbs.pop()?.close();
  }
});

test('stores Feishu instances independently per agent engine', () => {
  const { store } = createStore();

  store.setFeishuInstanceConfigForEngine(
    FeishuEngineKey.ClaudeCode,
    'claude-bot',
    createFeishuInstance('claude-bot', 'cli_claude'),
  );
  store.setFeishuInstanceConfigForEngine(
    FeishuEngineKey.Codex,
    'codex-bot',
    createFeishuInstance('codex-bot', 'cli_codex'),
  );

  expect(store.getFeishuInstances(FeishuEngineKey.ClaudeCode)).toMatchObject([
    { instanceId: 'claude-bot', appId: 'cli_claude', engineKey: FeishuEngineKey.ClaudeCode },
  ]);
  expect(store.getFeishuInstances(FeishuEngineKey.Codex)).toMatchObject([
    { instanceId: 'codex-bot', appId: 'cli_codex', engineKey: FeishuEngineKey.Codex },
  ]);
  expect(store.getFeishuInstances(FeishuEngineKey.OpenClaw)).toEqual([]);
});

test('migrates legacy Feishu instance rows to the target engine profile', () => {
  const { db, store } = createStore();
  const legacyInstance = createFeishuInstance('legacy-bot', 'cli_legacy');
  db.prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
    .run('feishu:legacy-bot', JSON.stringify(legacyInstance), Date.now());

  const migrated = store.migrateLegacyFeishuInstances(FeishuEngineKey.OpenClaw);

  expect(migrated).toBe(true);
  expect(store.getFeishuInstances(FeishuEngineKey.OpenClaw)).toMatchObject([
    { instanceId: 'legacy-bot', appId: 'cli_legacy', engineKey: FeishuEngineKey.OpenClaw },
  ]);
  expect(db.prepare('SELECT key FROM im_config WHERE key = ?').get('feishu:legacy-bot')).toBeUndefined();
});

test('detects duplicate Feishu app ids across engine profiles', () => {
  const { store } = createStore();

  store.setFeishuInstanceConfigForEngine(
    FeishuEngineKey.OpenClaw,
    'openclaw-bot',
    createFeishuInstance('openclaw-bot', 'cli_shared'),
  );
  store.setFeishuInstanceConfigForEngine(
    FeishuEngineKey.Hermes,
    'hermes-bot',
    createFeishuInstance('hermes-bot', 'cli_shared'),
  );

  expect(store.getFeishuConflicts()).toEqual([
    {
      appId: 'cli_shared',
      engineKeys: [FeishuEngineKey.OpenClaw, FeishuEngineKey.Hermes],
      instanceIds: ['openclaw-bot', 'hermes-bot'],
    },
  ]);
});
