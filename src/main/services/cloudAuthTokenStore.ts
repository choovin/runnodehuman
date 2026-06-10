import type Database from 'better-sqlite3-multiple-ciphers';

import type { CloudAuthTokens } from '../../shared/cloudAuth/parsers';

const TOKEN_KEY = 'cloud_auth_tokens';

export class CloudAuthTokenStore {
  constructor(private readonly db: Database.Database) {}

  async save(tokens: CloudAuthTokens): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
    );
    stmt.run(TOKEN_KEY, JSON.stringify(tokens), Date.now());
  }

  async load(): Promise<CloudAuthTokens | null> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(TOKEN_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudAuthTokens;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(TOKEN_KEY);
  }
}
