import Database from 'better-sqlite3-multiple-ciphers';
import { v4 as uuidv4 } from 'uuid';

import type { CoworkMessage, CoworkMessageMetadata, CoworkMessageType } from './coworkStore';

export const RuntimeEventType = {
  SessionCreated: 'session.created',
  SessionStatus: 'session.status',
  MessageDelta: 'message.delta',
  MessageFinal: 'message.final',
  ToolStarted: 'tool.started',
  ToolUpdated: 'tool.updated',
  ToolCompleted: 'tool.completed',
  PermissionRequested: 'permission.requested',
  PermissionResolved: 'permission.resolved',
  RuntimeMetric: 'runtime.metric',
} as const;
export type RuntimeEventType = typeof RuntimeEventType[keyof typeof RuntimeEventType];

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  source: string;
  sourceEventId?: string | null;
  type: RuntimeEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AppendRuntimeEventInput {
  id?: string;
  sessionId: string;
  source: string;
  sourceEventId?: string | null;
  type: RuntimeEventType;
  payload: Record<string, unknown>;
  createdAt?: number;
}

interface CoworkEventRow {
  id: string;
  session_id: string;
  source: string;
  source_event_id: string | null;
  type: RuntimeEventType;
  payload_json: string;
  created_at: number;
}

const MESSAGE_EVENT_TYPES = new Set<RuntimeEventType>([
  RuntimeEventType.MessageDelta,
  RuntimeEventType.MessageFinal,
  RuntimeEventType.ToolStarted,
  RuntimeEventType.ToolUpdated,
  RuntimeEventType.ToolCompleted,
]);

export function ensureCoworkEventSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_event_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      UNIQUE (source, source_event_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_events_session_created
    ON cowork_events(session_id, created_at, id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cowork_events_type_created
    ON cowork_events(type, created_at);
  `);
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapEventRow(row: CoworkEventRow): RuntimeEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    type: row.type,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
  };
}

function getPayloadMessage(payload: Record<string, unknown>): CoworkMessage | null {
  const value = payload.message;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const type = typeof record.type === 'string' ? record.type : '';
  const content = typeof record.content === 'string' ? record.content : '';
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Date.now();
  if (!id || !type) {
    return null;
  }
  return {
    id,
    type: type as CoworkMessageType,
    content,
    timestamp,
    sequence: typeof record.sequence === 'number' ? record.sequence : null,
    metadata: record.metadata && typeof record.metadata === 'object'
      ? record.metadata as CoworkMessageMetadata
      : undefined,
  };
}

export class CoworkEventStore {
  constructor(private readonly db: Database.Database) {}

  appendEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    const event: RuntimeEvent = {
      id: input.id || uuidv4(),
      sessionId: input.sessionId,
      source: input.source,
      sourceEventId: input.sourceEventId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? Date.now(),
    };

    this.db.prepare(`
      INSERT OR IGNORE INTO cowork_events (id, session_id, source, source_event_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.sessionId,
      event.source,
      event.sourceEventId,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    );

    const row = event.sourceEventId
      ? this.db.prepare(`
        SELECT id, session_id, source, source_event_id, type, payload_json, created_at
        FROM cowork_events
        WHERE source = ? AND source_event_id = ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(event.source, event.sourceEventId) as CoworkEventRow | undefined
      : this.db.prepare(`
        SELECT id, session_id, source, source_event_id, type, payload_json, created_at
        FROM cowork_events
        WHERE id = ?
        LIMIT 1
      `).get(event.id) as CoworkEventRow | undefined;

    return row ? mapEventRow(row) : event;
  }

  appendEvents(events: AppendRuntimeEventInput[]): RuntimeEvent[] {
    const append = this.db.transaction((items: AppendRuntimeEventInput[]) => (
      items.map((event) => this.appendEvent(event))
    ));
    return append(events);
  }

  listEvents(sessionId: string, input: { afterCreatedAt?: number; limit?: number } = {}): RuntimeEvent[] {
    const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)));
    const afterCreatedAt = Number.isFinite(input.afterCreatedAt) ? input.afterCreatedAt as number : -1;
    const rows = this.db.prepare(`
      SELECT id, session_id, source, source_event_id, type, payload_json, created_at
      FROM cowork_events
      WHERE session_id = ? AND created_at > ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, afterCreatedAt, limit) as CoworkEventRow[];
    return rows.map(mapEventRow);
  }

  reduceEventsToMessages(sessionId: string): CoworkMessage[] {
    const events = this.listAllSessionEvents(sessionId);
    const messagesById = new Map<string, CoworkMessage>();
    for (const event of events) {
      if (!MESSAGE_EVENT_TYPES.has(event.type)) {
        continue;
      }
      const message = getPayloadMessage(event.payload);
      if (message) {
        messagesById.set(message.id, {
          ...messagesById.get(message.id),
          ...message,
        });
        continue;
      }
      const messageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : '';
      if (!messageId || !messagesById.has(messageId)) {
        continue;
      }
      const existing = messagesById.get(messageId)!;
      messagesById.set(messageId, {
        ...existing,
        content: typeof event.payload.content === 'string' ? event.payload.content : existing.content,
        metadata: event.payload.metadata && typeof event.payload.metadata === 'object'
          ? event.payload.metadata as CoworkMessageMetadata
          : existing.metadata,
      });
    }
    return Array.from(messagesById.values()).sort((left, right) => {
      const leftSeq = typeof left.sequence === 'number' ? left.sequence : Number.MAX_SAFE_INTEGER;
      const rightSeq = typeof right.sequence === 'number' ? right.sequence : Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) return leftSeq - rightSeq;
      return left.timestamp - right.timestamp;
    });
  }

  private listAllSessionEvents(sessionId: string): RuntimeEvent[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, source, source_event_id, type, payload_json, created_at
      FROM cowork_events
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as CoworkEventRow[];
    return rows.map(mapEventRow);
  }

  rebuildMessageView(sessionId: string): CoworkMessage[] {
    return this.reduceEventsToMessages(sessionId);
  }

  getTimelineSummary(limit = 200): Record<string, unknown> {
    const rows = this.db.prepare(`
      SELECT id, session_id, source, source_event_id, type, payload_json, created_at
      FROM cowork_events
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(1000, Math.floor(limit)))) as CoworkEventRow[];
    const byType: Record<string, number> = {};
    const recentEvents = rows.map((row) => {
      byType[row.type] = (byType[row.type] || 0) + 1;
      const payload = parsePayload(row.payload_json);
      const message = getPayloadMessage(payload);
      return {
        id: row.id,
        sessionId: row.session_id,
        source: row.source,
        sourceEventId: row.source_event_id,
        type: row.type,
        createdAt: row.created_at,
        messageId: message?.id,
        messageType: message?.type,
        contentLength: message?.content.length ?? (typeof payload.content === 'string' ? payload.content.length : undefined),
      };
    });
    return {
      sampledAt: new Date().toISOString(),
      totalSampled: recentEvents.length,
      byType,
      recentEvents,
    };
  }
}
