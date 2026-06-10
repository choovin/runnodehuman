import type Database from 'better-sqlite3-multiple-ciphers';

const DEVICE_KEY = 'cloud_device_id';

export interface CloudDeviceRecord {
  deviceId: string;
  createdAt: number;
  lastHeartbeatAt: number | null;
}

export class CloudUserDeviceStore {
  constructor(private readonly db: Database.Database) {}

  async save(record: CloudDeviceRecord): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
    );
    stmt.run(DEVICE_KEY, JSON.stringify(record), Date.now());
  }

  async load(): Promise<CloudDeviceRecord | null> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(DEVICE_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudDeviceRecord;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(DEVICE_KEY);
  }
}
