import type Database from 'better-sqlite3-multiple-ciphers';

import type { CloudPlatformProviderRecord } from '../../shared/cloudPlatformProvider/types';

const KEY = 'current';

export class CloudPlatformProviderStore {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_platform_provider (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async save(record: CloudPlatformProviderRecord): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO cloud_platform_provider (key, value) VALUES (?, ?)'
    ).run(KEY, JSON.stringify(record));
  }

  async load(): Promise<CloudPlatformProviderRecord | null> {
    const row = this.db.prepare(
      'SELECT value FROM cloud_platform_provider WHERE key = ?'
    ).get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudPlatformProviderRecord;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM cloud_platform_provider WHERE key = ?').run(KEY);
  }
}
