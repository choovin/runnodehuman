import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, expect, test } from 'vitest';

import {
  CoworkAgentEngine,
  RuntimeCallSource,
  RuntimeCallStatus,
} from '../shared/cowork/constants';
import {
  calculateModelTps,
  calculateRuntimeTps,
} from '../shared/cowork/runtimeMetrics';
import { RuntimeTelemetryStore } from './runtimeTelemetryStore';

let db: Database.Database;
let store: RuntimeTelemetryStore;

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
  const now = Date.now();
  db.prepare(`
    INSERT INTO cowork_sessions (
      id, title, cwd, system_prompt, execution_mode, active_skill_ids, agent_id, created_at, updated_at
    )
    VALUES ('session-1', 'Runtime Test', '/tmp', '', 'local', '[]', 'main', ?, ?)
  `).run(now, now);
  store = new RuntimeTelemetryStore(db);
};

beforeEach(() => {
  setupDb();
});

test('records runtime calls and aggregates summary metrics', () => {
  const startedAt = Date.now() - 3200;
  store.createCall({
    id: 'call-1',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.Codex,
    providerKey: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5.4',
    modelName: 'gpt-5.4',
    configSource: 'wesight_model',
    cwd: '/tmp',
    startedAt,
    inputTokens: 100,
    contextTokens: 120,
    tokensEstimated: true,
  });

  store.markAssistantOutput('call-1', startedAt + 200);
  store.updateAssistantEstimate('call-1', 40, 10);
  store.markAssistantOutput('call-1', startedAt + 2200);
  store.updateAssistantEstimate('call-1', 80, 20);
  store.applyUsage('call-1', {
    inputTokens: 111,
    outputTokens: 22,
    contextTokens: 133,
    tokensEstimated: false,
  });
  store.updateToolStats('call-1', 1, 1, 50, [{
    toolName: 'Bash',
    toolUseId: 'tool-1',
    startedAt: startedAt + 300,
    completedAt: startedAt + 350,
    durationMs: 50,
  }]);
  store.finishCall('call-1', RuntimeCallStatus.Completed, startedAt + 3200);

  const summary = store.getSummary();
  expect(summary.totalCalls).toBe(1);
  expect(summary.completedCalls).toBe(1);
  expect(summary.totalInputTokens).toBe(111);
  expect(summary.totalOutputTokens).toBe(22);
  expect(summary.estimatedTokenCalls).toBe(0);
  expect(summary.avgTtftMs).toBe(200);
  expect(summary.avgRuntimeTps).toBeCloseTo(10);
  expect(summary.avgModelTps).toBeCloseTo(116.7, 1);
  expect(summary.avgTps).toBeCloseTo(116.7, 1);
  expect(summary.callsByEngine[0].key).toBe(CoworkAgentEngine.Codex);

  const list = store.listCalls();
  expect(list.total).toBe(1);
  expect(list.calls[0].sessionTitle).toBe('Runtime Test');
  expect(list.calls[0].firstOutputAt).toBe(startedAt + 200);
  expect(list.calls[0].lastOutputAt).toBe(startedAt + 2200);
  expect(list.calls[0].visibleOutputTokens).toBe(20);
  expect(list.calls[0].visibleOutputUpdates).toBe(2);
  expect(list.calls[0].toolCallCount).toBe(1);
  expect(list.calls[0].metadata.tools).toHaveLength(1);
});

test('uses visible output tokens for TPS when official usage includes hidden tokens', () => {
  const startedAt = Date.now() - 20_000;
  store.createCall({
    id: 'call-hidden',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Im,
    engine: CoworkAgentEngine.Codex,
    providerKey: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5.5',
    modelName: 'gpt-5.5',
    configSource: 'local_cli',
    cwd: '/tmp',
    startedAt,
    inputTokens: 1000,
    contextTokens: 1000,
    tokensEstimated: true,
  });

  store.markAssistantOutput('call-hidden', startedAt + 17_500);
  store.updateAssistantEstimate('call-hidden', 45, 12);
  store.markAssistantOutput('call-hidden', startedAt + 19_000);
  store.updateAssistantEstimate('call-hidden', 91, 24);
  store.applyUsage('call-hidden', {
    inputTokens: 146_212,
    outputTokens: 1_358,
    contextTokens: 146_212,
    tokensEstimated: false,
  });
  store.finishCall('call-hidden', RuntimeCallStatus.Completed, startedAt + 19_100);

  const call = store.listCalls().calls[0];
  expect(call.outputTokens).toBe(1_358);
  expect(call.visibleOutputTokens).toBe(24);

  const summary = store.getSummary();
  expect(summary.totalOutputTokens).toBe(1_358);
  expect(summary.avgRuntimeTps).toBeCloseTo(16);
  expect(summary.avgModelTps).toBeCloseTo(127.7, 1);
});

test('uses runtime-correlated highspeed GLM estimates within the model range', () => {
  const startedAt = Date.now() - 5000;
  store.createCall({
    id: 'call-glm-highspeed',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.ClaudeCode,
    providerKey: 'zhipu',
    providerName: 'Zhipu',
    modelId: 'glm-5.1-highspeed',
    modelName: 'GLM-5.1-HighSpeed',
    configSource: 'wesight_model',
    cwd: '/tmp',
    startedAt,
    inputTokens: 800,
    contextTokens: 900,
    tokensEstimated: true,
  });

  store.markAssistantOutput('call-glm-highspeed', startedAt + 2300);
  store.updateAssistantEstimate('call-glm-highspeed', 80, 35);
  store.markAssistantOutput('call-glm-highspeed', startedAt + 4500);
  store.updateAssistantEstimate('call-glm-highspeed', 159, 70);
  store.finishCall('call-glm-highspeed', RuntimeCallStatus.Completed, startedAt + 4500);

  const summary = store.getSummary();
  expect(summary.avgRuntimeTps).toBeCloseTo(31.8, 1);
  expect(summary.avgModelTps).toBeCloseTo(308.4, 1);

  const slowCall = store.listCalls().calls[0];

  store.createCall({
    id: 'call-glm-highspeed-fast',
    sessionId: 'session-1',
    turnIndex: 2,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.ClaudeCode,
    providerKey: 'zhipu',
    providerName: 'Zhipu',
    modelId: 'glm-5.1-highspeed',
    modelName: 'GLM-5.1-HighSpeed',
    configSource: 'wesight_model',
    cwd: '/tmp',
    startedAt: startedAt + 100,
    inputTokens: 800,
    contextTokens: 900,
    tokensEstimated: true,
  });

  store.markAssistantOutput('call-glm-highspeed-fast', startedAt + 2400);
  store.updateAssistantEstimate('call-glm-highspeed-fast', 80, 35);
  store.markAssistantOutput('call-glm-highspeed-fast', startedAt + 2700);
  store.updateAssistantEstimate('call-glm-highspeed-fast', 159, 70);
  store.finishCall('call-glm-highspeed-fast', RuntimeCallStatus.Completed, startedAt + 2700);

  const [fastCall] = store.listCalls().calls;
  expect(calculateRuntimeTps(fastCall)).toBeGreaterThan(calculateRuntimeTps(slowCall) ?? 0);
  expect(calculateModelTps(fastCall)).toBeGreaterThan(calculateModelTps(slowCall) ?? 0);
  expect(calculateModelTps(fastCall)).toBeLessThanOrEqual(350);
  expect(calculateModelTps(slowCall)).toBeGreaterThanOrEqual(300);
});

test('does not calculate output-phase TPS for batch-only CLI output', () => {
  const startedAt = Date.now() - 20_000;
  store.createCall({
    id: 'call-batch-output',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.Codex,
    providerKey: 'deepseek',
    providerName: 'DeepSeek',
    modelId: 'deepseek-reasoner',
    modelName: 'deepseek-reasoner',
    configSource: 'wesight_model',
    cwd: '/tmp',
    startedAt,
    inputTokens: 100,
    contextTokens: 100,
    tokensEstimated: true,
  });

  store.markAssistantOutput('call-batch-output', startedAt + 19_500);
  store.updateAssistantEstimate('call-batch-output', 400, 100);
  store.finishCall('call-batch-output', RuntimeCallStatus.Completed, startedAt + 19_700);

  const call = store.listCalls().calls[0];
  expect(call.visibleOutputUpdates).toBe(1);
  expect(calculateRuntimeTps(call)).toBeNull();
  expect(calculateModelTps(call)).toBeCloseTo(75);
  expect(store.getSummary().avgRuntimeTps).toBeNull();
});

test('resets running runtime calls after app restart', () => {
  const startedAt = Date.now() - 10_000;
  const completedAt = startedAt + 9000;
  store.createCall({
    id: 'call-running',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.ClaudeCode,
    providerKey: 'deepseek',
    providerName: 'DeepSeek',
    modelId: 'deepseek-v4-pro',
    modelName: 'deepseek-v4-pro',
    configSource: 'wesight_model',
    cwd: '/tmp',
    startedAt,
    inputTokens: 10,
    contextTokens: 10,
    tokensEstimated: true,
  });

  expect(store.resetRunningCalls(completedAt)).toBe(1);

  const call = store.listCalls().calls[0];
  expect(call.status).toBe(RuntimeCallStatus.Stopped);
  expect(call.completedAt).toBe(completedAt);
  expect(call.durationMs).toBe(9000);
  expect(call.error).toBe('Stopped after app restart.');
});

test('deletes runtime calls for removed sessions', () => {
  store.createCall({
    id: 'call-1',
    sessionId: 'session-1',
    turnIndex: 1,
    agentId: 'main',
    source: RuntimeCallSource.Chat,
    engine: CoworkAgentEngine.ClaudeCode,
    providerKey: null,
    providerName: null,
    modelId: null,
    modelName: null,
    configSource: null,
    cwd: '/tmp',
    startedAt: Date.now(),
    inputTokens: 1,
    contextTokens: 1,
    tokensEstimated: true,
  });

  expect(store.listCalls().total).toBe(1);
  store.deleteBySession('session-1');
  expect(store.listCalls().total).toBe(0);
});
