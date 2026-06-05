import Database from 'better-sqlite3-multiple-ciphers';

import {
  type CoworkAgentEngine,
  isRuntimeCallSource,
  isRuntimeCallStatus,
  RuntimeCallSource,
  RuntimeCallStatus,
} from '../shared/cowork/constants';
import type {
  RuntimeCallRecord,
  RuntimeMetricsBreakdownItem,
  RuntimeMetricsDetailResult,
  RuntimeMetricsFilters,
  RuntimeMetricsListResult,
  RuntimeMetricsSummary,
  RuntimeMetricsTimePoint,
  RuntimeToolMetric,
} from '../shared/cowork/runtimeMetrics';
import {
  calculateModelTps,
  calculateRuntimeTps,
  estimateTextTokensForRuntimeMetrics,
  estimateVisibleOutputTokensFromChars,
} from '../shared/cowork/runtimeMetrics';

type SqlParam = string | number | null;

interface RuntimeCallRow {
  id: string;
  session_id: string;
  session_title: string | null;
  turn_index: number;
  agent_id: string | null;
  source: string;
  engine: CoworkAgentEngine;
  provider_key: string | null;
  provider_name: string | null;
  model_id: string | null;
  model_name: string | null;
  config_source: string | null;
  cwd: string | null;
  status: string;
  started_at: number;
  first_output_at: number | null;
  last_output_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  context_tokens: number | null;
  tokens_estimated: number;
  output_chars: number;
  visible_output_tokens: number | null;
  visible_output_updates: number | null;
  tool_call_count: number;
  tool_latency_ms: number | null;
  agent_steps: number;
  estimated_cost_usd: number | null;
  error: string | null;
  metadata: string | null;
}

export interface RuntimeCallCreateInput {
  id: string;
  sessionId: string;
  turnIndex: number;
  agentId: string | null;
  source: RuntimeCallSource;
  engine: CoworkAgentEngine;
  providerKey: string | null;
  providerName: string | null;
  modelId: string | null;
  modelName: string | null;
  configSource: string | null;
  cwd: string | null;
  startedAt: number;
  inputTokens: number | null;
  contextTokens: number | null;
  tokensEstimated: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeUsageUpdate {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  contextTokens?: number | null;
  tokensEstimated?: boolean;
}

const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
};

const clampOffset = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
};

const toNullableNumber = (value: number | null | undefined): number | null => {
  return Number.isFinite(value) ? Number(value) : null;
};

const parseMetadata = (value: string | null): RuntimeCallRecord['metadata'] => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RuntimeCallRecord['metadata']
      : {};
  } catch {
    return {};
  }
};

const stringifyMetadata = (value: Record<string, unknown> | undefined): string | null => {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
};

const percentile = (values: number[], ratio: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
};

const average = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const getBucketSizeMs = (from: number, to: number): number => {
  const range = Math.max(0, to - from);
  if (range <= 2 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (range <= 45 * 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
};

export class RuntimeTelemetryStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  getNextTurnIndex(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(turn_index), 0) + 1 AS next_index FROM cowork_runtime_calls WHERE session_id = ?')
      .get(sessionId) as { next_index: number } | undefined;
    return row?.next_index ?? 1;
  }

  createCall(input: RuntimeCallCreateInput): void {
    this.db
      .prepare(
        `
        INSERT INTO cowork_runtime_calls (
          id, session_id, turn_index, agent_id, source, engine, provider_key,
          provider_name, model_id, model_name, config_source, cwd, status,
          started_at, input_tokens, context_tokens, tokens_estimated, metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.id,
        input.sessionId,
        input.turnIndex,
        input.agentId,
        input.source,
        input.engine,
        input.providerKey,
        input.providerName,
        input.modelId,
        input.modelName,
        input.configSource,
        input.cwd,
        RuntimeCallStatus.Running,
        input.startedAt,
        input.inputTokens,
        input.contextTokens,
        input.tokensEstimated ? 1 : 0,
        stringifyMetadata(input.metadata),
      );
  }

  markAssistantOutput(callId: string, outputAt: number): void {
    const row = this.db
      .prepare('SELECT started_at, first_output_at FROM cowork_runtime_calls WHERE id = ?')
      .get(callId) as { started_at: number; first_output_at: number | null } | undefined;
    if (!row) return;
    if (row.first_output_at) {
      this.db
        .prepare('UPDATE cowork_runtime_calls SET last_output_at = ? WHERE id = ?')
        .run(outputAt, callId);
      return;
    }
    this.db
      .prepare('UPDATE cowork_runtime_calls SET first_output_at = ?, last_output_at = ?, ttft_ms = ? WHERE id = ?')
      .run(outputAt, outputAt, Math.max(0, outputAt - row.started_at), callId);
  }

  markFirstOutput(callId: string, firstOutputAt: number): void {
    this.markAssistantOutput(callId, firstOutputAt);
  }

  updateAssistantEstimate(callId: string, outputChars: number, outputTokens: number): void {
    this.db
      .prepare(
        `
        UPDATE cowork_runtime_calls
        SET output_chars = ?,
            visible_output_updates = CASE WHEN ? > COALESCE(visible_output_tokens, 0) THEN visible_output_updates + 1 ELSE visible_output_updates END,
            visible_output_tokens = ?,
            output_tokens = CASE WHEN tokens_estimated = 1 THEN ? ELSE output_tokens END
        WHERE id = ?
      `,
      )
      .run(
        Math.max(0, outputChars),
        Math.max(0, outputTokens),
        Math.max(0, outputTokens),
        Math.max(0, outputTokens),
        callId,
      );
  }

  applyUsage(callId: string, usage: RuntimeUsageUpdate): void {
    const setClauses: string[] = [];
    const values: SqlParam[] = [];
    const addNumber = (column: string, value: number | null | undefined): void => {
      if (value === undefined) return;
      setClauses.push(`${column} = ?`);
      values.push(toNullableNumber(value));
    };

    addNumber('input_tokens', usage.inputTokens);
    addNumber('output_tokens', usage.outputTokens);
    addNumber('cache_read_tokens', usage.cacheReadTokens);
    addNumber('cache_write_tokens', usage.cacheWriteTokens);
    addNumber('context_tokens', usage.contextTokens);
    if (usage.tokensEstimated !== undefined) {
      setClauses.push('tokens_estimated = ?');
      values.push(usage.tokensEstimated ? 1 : 0);
    }
    if (setClauses.length === 0) return;
    values.push(callId);
    this.db
      .prepare(`UPDATE cowork_runtime_calls SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  updateToolStats(
    callId: string,
    toolCallCount: number,
    agentSteps: number,
    toolLatencyMs: number | null,
    tools: RuntimeToolMetric[],
  ): void {
    this.db
      .prepare(
        `
        UPDATE cowork_runtime_calls
        SET tool_call_count = ?,
            agent_steps = ?,
            tool_latency_ms = ?,
            metadata = ?
        WHERE id = ?
      `,
      )
      .run(
        Math.max(0, toolCallCount),
        Math.max(0, agentSteps),
        toolLatencyMs,
        stringifyMetadata({ tools }),
        callId,
      );
  }

  finishCall(callId: string, status: RuntimeCallStatus, completedAt: number, error?: string | null): void {
    const row = this.db
      .prepare('SELECT started_at FROM cowork_runtime_calls WHERE id = ?')
      .get(callId) as { started_at: number } | undefined;
    if (!row) return;
    this.db
      .prepare(
        `
        UPDATE cowork_runtime_calls
        SET status = ?,
            completed_at = ?,
            duration_ms = ?,
            error = ?
        WHERE id = ?
      `,
      )
      .run(status, completedAt, Math.max(0, completedAt - row.started_at), error ?? null, callId);
  }

  resetRunningCalls(completedAt: number = Date.now()): number {
    const result = this.db
      .prepare(
        `
        UPDATE cowork_runtime_calls
        SET status = ?,
            completed_at = ?,
            duration_ms = MAX(0, ? - started_at),
            error = COALESCE(error, ?)
        WHERE status = ?
      `,
      )
      .run(
        RuntimeCallStatus.Stopped,
        completedAt,
        completedAt,
        'Stopped after app restart.',
        RuntimeCallStatus.Running,
      );
    return result.changes;
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM cowork_runtime_calls WHERE session_id = ?').run(sessionId);
  }

  deleteBySessions(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const placeholders = sessionIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM cowork_runtime_calls WHERE session_id IN (${placeholders})`).run(...sessionIds);
  }

  listCalls(filters: RuntimeMetricsFilters = {}): RuntimeMetricsListResult {
    const where = this.buildWhere(filters);
    const limit = clampLimit(filters.limit, 50, 500);
    const offset = clampOffset(filters.offset);
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM cowork_runtime_calls c ${where.sql}`)
      .get(...where.params) as { count: number } | undefined;
    const rows = this.db
      .prepare(
        `
        SELECT c.*, s.title AS session_title
        FROM cowork_runtime_calls c
        LEFT JOIN cowork_sessions s ON s.id = c.session_id
        ${where.sql}
        ORDER BY c.started_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...where.params, limit, offset) as RuntimeCallRow[];
    return {
      total: totalRow?.count ?? 0,
      calls: rows.map((row) => this.mapRow(row)),
    };
  }

  getDetail(callId: string): RuntimeMetricsDetailResult {
    const row = this.db
      .prepare(
        `
        SELECT c.*, s.title AS session_title
        FROM cowork_runtime_calls c
        LEFT JOIN cowork_sessions s ON s.id = c.session_id
        WHERE c.id = ?
      `,
      )
      .get(callId) as RuntimeCallRow | undefined;
    return { call: row ? this.mapRow(row) : null };
  }

  getSummary(filters: RuntimeMetricsFilters = {}): RuntimeMetricsSummary {
    const where = this.buildWhere(filters);
    const rows = this.db
      .prepare(
        `
        SELECT c.*, s.title AS session_title
        FROM cowork_runtime_calls c
        LEFT JOIN cowork_sessions s ON s.id = c.session_id
        ${where.sql}
        ORDER BY c.started_at ASC
      `,
      )
      .all(...where.params) as RuntimeCallRow[];
    const calls = rows.map((row) => this.mapRow(row));
    const completed = calls.filter((call) => call.status === RuntimeCallStatus.Completed);
    const errored = calls.filter((call) => call.status === RuntimeCallStatus.Error);
    const stopped = calls.filter((call) => call.status === RuntimeCallStatus.Stopped);
    const running = calls.filter((call) => call.status === RuntimeCallStatus.Running);
    const finishedCalls = [...completed, ...errored, ...stopped];
    const completionValues = finishedCalls
      .map((call) => call.durationMs)
      .filter((value): value is number => value !== null);
    const ttftValues = calls
      .map((call) => call.ttftMs)
      .filter((value): value is number => value !== null);
    const runtimeTpsValues = calls
      .map(calculateRuntimeTps)
      .filter((value): value is number => value !== null);
    const modelTpsValues = calls
      .map(calculateModelTps)
      .filter((value): value is number => value !== null);
    const costValues = calls
      .map((call) => call.estimatedCostUsd)
      .filter((value): value is number => value !== null);

    return {
      totalCalls: calls.length,
      completedCalls: completed.length,
      errorCalls: errored.length,
      stoppedCalls: stopped.length,
      runningCalls: running.length,
      successRate: finishedCalls.length > 0 ? completed.length / finishedCalls.length : null,
      avgCompletionMs: average(completionValues),
      p95CompletionMs: percentile(completionValues, 0.95),
      avgTtftMs: average(ttftValues),
      avgTps: average(modelTpsValues),
      avgRuntimeTps: average(runtimeTpsValues),
      avgModelTps: average(modelTpsValues),
      totalInputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
      totalOutputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
      totalContextTokens: calls.reduce((sum, call) => sum + (call.contextTokens ?? 0), 0),
      estimatedTokenCalls: calls.filter((call) => call.tokensEstimated).length,
      estimatedCostUsd: costValues.length > 0 ? costValues.reduce((sum, value) => sum + value, 0) : null,
      callsByEngine: this.buildBreakdown(calls, (call) => call.engine, (call) => call.engine),
      callsByModel: this.buildBreakdown(
        calls,
        (call) => call.modelId || 'unknown',
        (call) => call.modelName || call.modelId || 'unknown',
      ),
      timeSeries: this.buildTimeSeries(calls, filters),
    };
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_runtime_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        agent_id TEXT,
        source TEXT NOT NULL DEFAULT 'chat',
        engine TEXT NOT NULL,
        provider_key TEXT,
        provider_name TEXT,
        model_id TEXT,
        model_name TEXT,
        config_source TEXT,
        cwd TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        first_output_at INTEGER,
        last_output_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        ttft_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        context_tokens INTEGER,
        tokens_estimated INTEGER NOT NULL DEFAULT 0,
        output_chars INTEGER NOT NULL DEFAULT 0,
        visible_output_tokens INTEGER,
        visible_output_updates INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        tool_latency_ms INTEGER,
        agent_steps INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL,
        error TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cowork_runtime_calls_started_at ON cowork_runtime_calls(started_at);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cowork_runtime_calls_session_started ON cowork_runtime_calls(session_id, started_at);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cowork_runtime_calls_engine_started ON cowork_runtime_calls(engine, started_at);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cowork_runtime_calls_model_started ON cowork_runtime_calls(model_id, started_at);');
    this.migrateColumns();
  }

  private migrateColumns(): void {
    try {
      const columns = this.db.pragma('table_info(cowork_runtime_calls)') as Array<{ name: string }>;
      const columnNames = columns.map((column) => column.name);
      if (!columnNames.includes('last_output_at')) {
        this.db.exec('ALTER TABLE cowork_runtime_calls ADD COLUMN last_output_at INTEGER;');
      }
      if (!columnNames.includes('visible_output_tokens')) {
        this.db.exec('ALTER TABLE cowork_runtime_calls ADD COLUMN visible_output_tokens INTEGER;');
      }
      if (!columnNames.includes('visible_output_updates')) {
        this.db.exec('ALTER TABLE cowork_runtime_calls ADD COLUMN visible_output_updates INTEGER NOT NULL DEFAULT 0;');
      }
      this.backfillVisibleOutputStats();
    } catch {
      // Column already exists or migration not needed.
    }
  }

  private backfillVisibleOutputStats(): void {
    const rows = this.db
      .prepare(
        `
        SELECT id, session_id, started_at, completed_at, output_chars
        FROM cowork_runtime_calls
        WHERE visible_output_tokens IS NULL
      `,
      )
      .all() as Array<{
        id: string;
        session_id: string;
        started_at: number;
        completed_at: number | null;
        output_chars: number;
      }>;
    const update = this.db.prepare(
      `
      UPDATE cowork_runtime_calls
      SET visible_output_tokens = ?,
          visible_output_updates = ?
      WHERE id = ?
    `,
    );
    const messageQuery = this.db.prepare(
      `
      SELECT content
      FROM cowork_messages
      WHERE session_id = ?
        AND type = 'assistant'
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at ASC
    `,
    );
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const completedAt = row.completed_at ?? Date.now();
        const messages = messageQuery.all(row.session_id, row.started_at, completedAt) as Array<{ content: string }>;
        const visibleText = messages.map((message) => message.content).join('\n');
        const visibleTokens = visibleText.trim()
          ? estimateTextTokensForRuntimeMetrics(visibleText)
          : estimateVisibleOutputTokensFromChars(row.output_chars);
        update.run(visibleTokens, visibleTokens ? 1 : 0, row.id);
      }
    });
    transaction();
  }

  private buildWhere(filters: RuntimeMetricsFilters): { sql: string; params: SqlParam[] } {
    const conditions: string[] = [];
    const params: SqlParam[] = [];
    if (Number.isFinite(filters.from)) {
      conditions.push('c.started_at >= ?');
      params.push(Math.floor(filters.from as number));
    }
    if (Number.isFinite(filters.to)) {
      conditions.push('c.started_at <= ?');
      params.push(Math.floor(filters.to as number));
    }
    if (filters.engine) {
      conditions.push('c.engine = ?');
      params.push(filters.engine);
    }
    if (filters.modelId) {
      conditions.push('c.model_id = ?');
      params.push(filters.modelId);
    }
    if (filters.providerKey) {
      conditions.push('c.provider_key = ?');
      params.push(filters.providerKey);
    }
    if (filters.status && isRuntimeCallStatus(filters.status)) {
      conditions.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.source && isRuntimeCallSource(filters.source)) {
      conditions.push('c.source = ?');
      params.push(filters.source);
    }
    if (filters.sessionId) {
      conditions.push('c.session_id = ?');
      params.push(filters.sessionId);
    }
    return {
      sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  private mapRow(row: RuntimeCallRow): RuntimeCallRecord {
    const status = isRuntimeCallStatus(row.status) ? row.status : RuntimeCallStatus.Error;
    const agentSteps = status === RuntimeCallStatus.Completed && row.agent_steps === 0
      ? 1
      : row.agent_steps;
    return {
      id: row.id,
      sessionId: row.session_id,
      sessionTitle: row.session_title,
      turnIndex: row.turn_index,
      agentId: row.agent_id,
      source: isRuntimeCallSource(row.source) ? row.source : RuntimeCallSource.Unknown,
      engine: row.engine,
      providerKey: row.provider_key,
      providerName: row.provider_name,
      modelId: row.model_id,
      modelName: row.model_name,
      configSource: row.config_source,
      cwd: row.cwd,
      status,
      startedAt: row.started_at,
      firstOutputAt: row.first_output_at,
      lastOutputAt: row.last_output_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      ttftMs: row.ttft_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      contextTokens: row.context_tokens,
      tokensEstimated: row.tokens_estimated === 1,
      outputChars: row.output_chars,
      visibleOutputTokens: row.visible_output_tokens ?? estimateVisibleOutputTokensFromChars(row.output_chars),
      visibleOutputUpdates: row.visible_output_updates ?? 0,
      toolCallCount: row.tool_call_count,
      toolLatencyMs: row.tool_latency_ms,
      agentSteps,
      estimatedCostUsd: row.estimated_cost_usd,
      error: row.error,
      metadata: parseMetadata(row.metadata),
    };
  }

  private buildBreakdown(
    calls: RuntimeCallRecord[],
    getKey: (call: RuntimeCallRecord) => string,
    getLabel: (call: RuntimeCallRecord) => string,
  ): RuntimeMetricsBreakdownItem[] {
    const groups = new Map<string, RuntimeMetricsBreakdownItem & { completionValues: number[] }>();
    for (const call of calls) {
      const key = getKey(call);
      const existing = groups.get(key) ?? {
        key,
        label: getLabel(call),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        avgCompletionMs: null,
        completionValues: [],
      };
      existing.calls += 1;
      existing.inputTokens += call.inputTokens ?? 0;
      existing.outputTokens += call.outputTokens ?? 0;
      if (call.durationMs !== null) {
        existing.completionValues.push(call.durationMs);
      }
      groups.set(key, existing);
    }
    return Array.from(groups.values())
      .map(({ completionValues, ...item }) => ({
        ...item,
        avgCompletionMs: average(completionValues),
      }))
      .sort((left, right) => right.calls - left.calls)
      .slice(0, 12);
  }

  private buildTimeSeries(calls: RuntimeCallRecord[], filters: RuntimeMetricsFilters): RuntimeMetricsTimePoint[] {
    if (calls.length === 0) return [];
    const first = filters.from ?? calls[0].startedAt;
    const last = filters.to ?? calls[calls.length - 1].startedAt;
    const bucketSizeMs = getBucketSizeMs(first, last);
    const groups = new Map<number, {
      calls: RuntimeCallRecord[];
      completionValues: number[];
      ttftValues: number[];
    }>();
    for (const call of calls) {
      const bucketStart = Math.floor(call.startedAt / bucketSizeMs) * bucketSizeMs;
      const group = groups.get(bucketStart) ?? { calls: [], completionValues: [], ttftValues: [] };
      group.calls.push(call);
      if (call.durationMs !== null) group.completionValues.push(call.durationMs);
      if (call.ttftMs !== null) group.ttftValues.push(call.ttftMs);
      groups.set(bucketStart, group);
    }
    return Array.from(groups.entries())
      .sort(([left], [right]) => left - right)
      .map(([bucketStart, group]) => ({
        bucketStart,
        calls: group.calls.length,
        completedCalls: group.calls.filter((call) => call.status === RuntimeCallStatus.Completed).length,
        errorCalls: group.calls.filter((call) => call.status === RuntimeCallStatus.Error).length,
        inputTokens: group.calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
        outputTokens: group.calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
        avgCompletionMs: average(group.completionValues),
        avgTtftMs: average(group.ttftValues),
      }));
  }
}
