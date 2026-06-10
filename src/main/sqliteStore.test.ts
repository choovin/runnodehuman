import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { ExternalAgentConfigSource } from '../shared/cowork/constants';
import { DB_FILENAME } from './appConstants';
import { SqliteStore } from './sqliteStore';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrates the old Codex config source default to local CLI', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-sqlite-'));
  tempDirs.push(userDataDir);
  const dbPath = path.join(userDataDir, DB_FILENAME);
  const db = new BetterSqlite3(dbPath);
  const now = Date.now();
  db.exec(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cowork_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db
    .prepare('INSERT INTO cowork_config (key, value, updated_at) VALUES (?, ?, ?)')
    .run('codexConfigSource', ExternalAgentConfigSource.WesightModel, now);
  db.close();

  const store = SqliteStore.create(userDataDir);
  const row = store
    .getDatabase()
    .prepare("SELECT value FROM cowork_config WHERE key = 'codexConfigSource'")
    .get() as { value: string } | undefined;
  const migrationFlag = store.get<string>('cowork.codexConfigSource.defaultLocalCli.v1.completed');
  store.close();

  expect(row?.value).toBe(ExternalAgentConfigSource.LocalCli);
  expect(migrationFlag).toBe('1');
});
