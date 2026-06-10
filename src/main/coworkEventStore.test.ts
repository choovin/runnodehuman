import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { CoworkEventStore, RuntimeEventType } from './coworkEventStore';

let db: Database.Database;
let store: CoworkEventStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE cowork_events (
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
    CREATE INDEX idx_cowork_events_session_created
      ON cowork_events(session_id, created_at, id);
    CREATE INDEX idx_cowork_events_type_created
      ON cowork_events(type, created_at);
    INSERT INTO cowork_sessions (id, title) VALUES ('session-1', 'Test');
  `);
  store = new CoworkEventStore(db);
});

afterEach(() => {
  db.close();
});

test('returns the existing event when source event id is appended twice', () => {
  const first = store.appendEvent({
    id: 'event-1',
    sessionId: 'session-1',
    source: 'runtime',
    sourceEventId: 'source-1',
    type: RuntimeEventType.SessionCreated,
    payload: { title: 'first' },
    createdAt: 100,
  });
  const second = store.appendEvent({
    id: 'event-2',
    sessionId: 'session-1',
    source: 'runtime',
    sourceEventId: 'source-1',
    type: RuntimeEventType.SessionCreated,
    payload: { title: 'second' },
    createdAt: 200,
  });

  expect(second).toEqual(first);
  expect(store.listEvents('session-1')).toHaveLength(1);
});

test('reduces final message and delta events into a replayed message view', () => {
  store.appendEvents([
    {
      id: 'event-1',
      sessionId: 'session-1',
      source: 'runtime',
      sourceEventId: 'message-1',
      type: RuntimeEventType.MessageFinal,
      payload: {
        message: {
          id: 'message-1',
          type: 'assistant',
          content: 'draft',
          timestamp: 100,
          sequence: 1,
          metadata: { isStreaming: true },
        },
      },
      createdAt: 100,
    },
    {
      id: 'event-2',
      sessionId: 'session-1',
      source: 'runtime',
      type: RuntimeEventType.MessageDelta,
      payload: {
        messageId: 'message-1',
        content: 'final',
        metadata: { isStreaming: false, isFinal: true },
      },
      createdAt: 200,
    },
  ]);

  expect(store.rebuildMessageView('session-1')).toEqual([{
    id: 'message-1',
    type: 'assistant',
    content: 'final',
    timestamp: 100,
    sequence: 1,
    metadata: { isStreaming: false, isFinal: true },
  }]);
});

test('does not turn runtime metric events into messages', () => {
  store.appendEvent({
    sessionId: 'session-1',
    source: 'performance',
    type: RuntimeEventType.RuntimeMetric,
    payload: { durationMs: 42 },
    createdAt: 100,
  });

  expect(store.reduceEventsToMessages('session-1')).toEqual([]);
  expect(store.getTimelineSummary()).toMatchObject({
    totalSampled: 1,
    byType: {
      [RuntimeEventType.RuntimeMetric]: 1,
    },
  });
});
