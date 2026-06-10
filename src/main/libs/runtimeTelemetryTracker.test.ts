import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock' },
}));

import {
  CoworkAgentEngine,
  RuntimeCallStatus,
} from '../../shared/cowork/constants';
import { CoworkStore } from '../coworkStore';
import { RuntimeTelemetryStore } from '../runtimeTelemetryStore';
import { RuntimeTelemetryTracker } from './runtimeTelemetryTracker';

let db: Database.Database;
let coworkStore: CoworkStore;
let telemetryStore: RuntimeTelemetryStore;
let tracker: RuntimeTelemetryTracker;

const setupDb = (): void => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      codex_app_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      execution_mode TEXT,
      active_skill_ids TEXT,
      runtime_snapshot_json TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      session_kind TEXT NOT NULL DEFAULT 'single',
      parent_session_id TEXT,
      team_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER
    );
  `);
  coworkStore = new CoworkStore(db);
  telemetryStore = new RuntimeTelemetryStore(db);
  tracker = new RuntimeTelemetryTracker({
    store: coworkStore,
    telemetryStore,
    getModelSnapshot: () => ({
      providerKey: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-5.4',
      modelName: 'gpt-5.4',
      configSource: 'wesight_model',
    }),
  });
};

beforeEach(() => {
  setupDb();
});

test('tracks a completed turn with first output and tool timing', () => {
  const session = coworkStore.createSession('Tracker Test', '/tmp', '', 'local');
  tracker.startTurn(session.id, 'hello', CoworkAgentEngine.Codex, {});

  const assistant = coworkStore.addMessage(session.id, {
    type: 'assistant',
    content: 'hi',
  });
  tracker.recordMessage(session.id, assistant);

  const toolUse = coworkStore.addMessage(session.id, {
    type: 'tool_use',
    content: 'Using tool: Bash',
    metadata: {
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolInput: { command: 'pwd' },
    },
  });
  tracker.recordMessage(session.id, toolUse);

  const toolResult = coworkStore.addMessage(session.id, {
    type: 'tool_result',
    content: '/tmp',
    metadata: {
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolResult: '/tmp',
    },
  });
  tracker.recordMessage(session.id, toolResult);
  tracker.recordRuntimeMetric(session.id, {
    type: 'usage',
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 12,
    tokensEstimated: false,
  });
  tracker.finishTurn(session.id, RuntimeCallStatus.Completed);

  const list = telemetryStore.listCalls();
  expect(list.total).toBe(1);
  expect(list.calls[0].status).toBe(RuntimeCallStatus.Completed);
  expect(list.calls[0].ttftMs).not.toBeNull();
  expect(list.calls[0].lastOutputAt).not.toBeNull();
  expect(list.calls[0].toolCallCount).toBe(1);
  expect(list.calls[0].agentSteps).toBe(2);
  expect(list.calls[0].inputTokens).toBe(10);
  expect(list.calls[0].tokensEstimated).toBe(false);
  expect(list.calls[0].metadata.tools?.[0]?.toolName).toBe('Bash');
});

test('counts a plain assistant reply as one model step', () => {
  const session = coworkStore.createSession('Plain Reply Test', '/tmp', '', 'local');
  tracker.startTurn(session.id, 'hello', CoworkAgentEngine.ClaudeCode, {});

  const assistant = coworkStore.addMessage(session.id, {
    type: 'assistant',
    content: 'hello',
  });
  tracker.recordMessage(session.id, assistant);
  tracker.finishTurn(session.id, RuntimeCallStatus.Completed);

  const list = telemetryStore.listCalls();
  expect(list.calls[0].toolCallCount).toBe(0);
  expect(list.calls[0].agentSteps).toBe(1);
});

test('marks failed turns with the error message', () => {
  const session = coworkStore.createSession('Failed Test', '/tmp', '', 'local');
  tracker.startTurn(session.id, 'fail', CoworkAgentEngine.ClaudeCode, {});
  tracker.finishTurn(session.id, RuntimeCallStatus.Error, 'boom');

  const detail = telemetryStore.getDetail(telemetryStore.listCalls().calls[0].id);
  expect(detail.call?.status).toBe(RuntimeCallStatus.Error);
  expect(detail.call?.error).toBe('boom');
});
