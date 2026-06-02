import { performance } from 'perf_hooks';

export type PerformanceTimingName =
  | 'app_ready_ms'
  | 'db_init_ms'
  | 'window_created_ms'
  | 'window_ready_to_show_ms'
  | 'window_did_finish_load_ms'
  | 'first_paint_ms'
  | 'first_interactive_ms'
  | 'config_loaded_ms'
  | 'recent_sessions_loaded_ms'
  | 'selected_engine_detect_ms'
  | 'selected_engine_ready_ms'
  | 'skills_ready_ms'
  | 'mcp_ready_ms'
  | 'im_ready_ms'
  | 'session_recovery_ms'
  | 'runtime_call_recovery_ms'
  | 't0_ready_ms'
  | 't1_ready_ms'
  | 't2_ready_ms';

export type SettingsMetricType =
  | 'open'
  | 'interactive'
  | 'tabLoad'
  | 'ipc';

export type IpcMetricType =
  | 'message'
  | 'messageUpdate'
  | 'fileActivity'
  | 'permission'
  | 'complete'
  | 'error';

export type DbMetricOperation =
  | 'getSession'
  | 'getSessionMeta'
  | 'getSessionRuntimeSnapshot'
  | 'getRecentMessages'
  | 'getMessagesAfter'
  | 'getMessagesBefore'
  | 'listSessions'
  | 'getConfig'
  | 'setConfig'
  | 'addMessage'
  | 'updateMessage';

export interface IpcMetricInput {
  type: IpcMetricType;
  sessionId?: string;
  channel: string;
  payload: unknown;
  windowCount?: number;
}

export interface DbMetricInput {
  operation: DbMetricOperation;
  durationMs: number;
  sessionId?: string;
  messageCount?: number;
  rowCount?: number;
  detail?: string;
}

export interface PerformanceSnapshotMetadata {
  appVersion?: string;
  platform?: string;
  arch?: string;
}

export interface DbSlowOperation extends DbMetricInput {
  recordedAt: number;
}

export interface IpcSessionSummary {
  sessionId: string;
  eventCount: number;
  maxEventsPerSecond: number;
}

export interface PerformanceSnapshot {
  sampledAt: string;
  uptimeMs: number;
  metadata: PerformanceSnapshotMetadata;
  startupTimings: Partial<Record<PerformanceTimingName, number>>;
  ipc: {
    totalEvents: number;
    totalPayloadBytes: number;
    maxPayloadBytes: number;
    maxMessageUpdatePayloadBytes: number;
    byType: Record<string, {
      count: number;
      payloadBytes: number;
      maxPayloadBytes: number;
      windowCount: number;
    }>;
    sessions: IpcSessionSummary[];
  };
  db: {
    totalOperations: number;
    slowThresholdMs: number;
    slowOperations: DbSlowOperation[];
    byOperation: Record<string, {
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      slowCount: number;
    }>;
  };
  settings: {
    totalEvents: number;
    recentEvents: SettingsMetric[];
    byType: Record<string, {
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
    }>;
    byOperation: Record<string, {
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
    }>;
  };
}

export interface SettingsMetric {
  type: SettingsMetricType;
  durationMs: number;
  recordedAt: number;
  tab?: string;
  channel?: string;
  success?: boolean;
  error?: string;
  triggeredRuntimeStart?: boolean;
}

const DEFAULT_DB_SLOW_THRESHOLD_MS = 100;
const MAX_SLOW_DB_OPERATIONS = 200;
const MAX_SETTINGS_METRICS = 200;

const processStartedAt = performance.now();
const startupTimings: Partial<Record<PerformanceTimingName, number>> = {};
const ipcByType = new Map<string, {
  count: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  windowCount: number;
}>();
const ipcSessions = new Map<string, {
  eventCount: number;
  currentBucketSecond: number;
  currentBucketCount: number;
  maxEventsPerSecond: number;
}>();
const dbByOperation = new Map<string, {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  slowCount: number;
}>();
const slowDbOperations: DbSlowOperation[] = [];
const settingsMetrics: SettingsMetric[] = [];
const settingsByType = new Map<string, {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}>();
const settingsByOperation = new Map<string, {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}>();

let totalIpcEvents = 0;
let totalIpcPayloadBytes = 0;
let maxIpcPayloadBytes = 0;
let maxMessageUpdatePayloadBytes = 0;
let dbOperationCount = 0;
let dbSlowThresholdMs = DEFAULT_DB_SLOW_THRESHOLD_MS;
let settingsMetricCount = 0;

export function nowMs(): number {
  return performance.now();
}

export function markTiming(
  name: PerformanceTimingName,
  startedAt: number = processStartedAt,
  options: { overwrite?: boolean } = {},
): number {
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (startupTimings[name] !== undefined && options.overwrite !== true) {
    return startupTimings[name] ?? durationMs;
  }
  startupTimings[name] = durationMs;
  console.debug(`[Performance] recorded ${name} in ${durationMs}ms`);
  return durationMs;
}

export function markTimingValue(
  name: PerformanceTimingName,
  durationMs: number,
  options: { overwrite?: boolean } = {},
): number {
  const normalizedDurationMs = Math.max(0, Math.round(durationMs));
  if (startupTimings[name] !== undefined && options.overwrite !== true) {
    return startupTimings[name] ?? normalizedDurationMs;
  }
  startupTimings[name] = normalizedDurationMs;
  console.debug(`[Performance] recorded ${name} in ${normalizedDurationMs}ms`);
  return normalizedDurationMs;
}

export async function measureAsync<T>(
  name: PerformanceTimingName,
  task: () => Promise<T>,
  startedAt: number = performance.now(),
): Promise<T> {
  try {
    return await task();
  } finally {
    markTiming(name, startedAt);
  }
}

export function getPayloadByteSize(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return 0;
  }
}

export function recordIpcSend(input: IpcMetricInput): void {
  const payloadBytes = getPayloadByteSize(input.payload);
  totalIpcEvents += 1;
  totalIpcPayloadBytes += payloadBytes;
  maxIpcPayloadBytes = Math.max(maxIpcPayloadBytes, payloadBytes);
  if (input.type === 'messageUpdate') {
    maxMessageUpdatePayloadBytes = Math.max(maxMessageUpdatePayloadBytes, payloadBytes);
  }

  const summary = ipcByType.get(input.type) ?? {
    count: 0,
    payloadBytes: 0,
    maxPayloadBytes: 0,
    windowCount: 0,
  };
  summary.count += 1;
  summary.payloadBytes += payloadBytes;
  summary.maxPayloadBytes = Math.max(summary.maxPayloadBytes, payloadBytes);
  summary.windowCount += input.windowCount ?? 0;
  ipcByType.set(input.type, summary);

  if (input.sessionId) {
    const bucketSecond = Math.floor(Date.now() / 1000);
    const sessionSummary = ipcSessions.get(input.sessionId) ?? {
      eventCount: 0,
      currentBucketSecond: bucketSecond,
      currentBucketCount: 0,
      maxEventsPerSecond: 0,
    };
    sessionSummary.eventCount += 1;
    if (sessionSummary.currentBucketSecond === bucketSecond) {
      sessionSummary.currentBucketCount += 1;
    } else {
      sessionSummary.currentBucketSecond = bucketSecond;
      sessionSummary.currentBucketCount = 1;
    }
    sessionSummary.maxEventsPerSecond = Math.max(
      sessionSummary.maxEventsPerSecond,
      sessionSummary.currentBucketCount,
    );
    ipcSessions.set(input.sessionId, sessionSummary);
  }
}

export function recordDbOperation(input: DbMetricInput): void {
  dbOperationCount += 1;
  const summary = dbByOperation.get(input.operation) ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    slowCount: 0,
  };
  summary.count += 1;
  summary.totalDurationMs += input.durationMs;
  summary.maxDurationMs = Math.max(summary.maxDurationMs, input.durationMs);

  if (input.durationMs >= dbSlowThresholdMs) {
    summary.slowCount += 1;
    const slowOperation: DbSlowOperation = {
      ...input,
      durationMs: Math.round(input.durationMs),
      recordedAt: Date.now(),
    };
    slowDbOperations.push(slowOperation);
    while (slowDbOperations.length > MAX_SLOW_DB_OPERATIONS) {
      slowDbOperations.shift();
    }
    console.warn(
      `[Performance] DB operation ${input.operation} took ${slowOperation.durationMs}ms.`,
    );
  }

  dbByOperation.set(input.operation, summary);
}

export function recordSettingsMetric(input: Omit<SettingsMetric, 'durationMs' | 'recordedAt'> & { durationMs?: number }): void {
  settingsMetricCount += 1;
  const metric: SettingsMetric = {
    ...input,
    durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
    recordedAt: Date.now(),
    error: input.error ? input.error.slice(0, 240) : undefined,
  };
  settingsMetrics.push(metric);
  while (settingsMetrics.length > MAX_SETTINGS_METRICS) {
    settingsMetrics.shift();
  }

  const summary = settingsByType.get(metric.type) ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  summary.count += 1;
  summary.totalDurationMs += metric.durationMs;
  summary.maxDurationMs = Math.max(summary.maxDurationMs, metric.durationMs);
  settingsByType.set(metric.type, summary);

  const operationKey = getSettingsOperationKey(metric);
  const operationSummary = settingsByOperation.get(operationKey) ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  operationSummary.count += 1;
  operationSummary.totalDurationMs += metric.durationMs;
  operationSummary.maxDurationMs = Math.max(operationSummary.maxDurationMs, metric.durationMs);
  settingsByOperation.set(operationKey, operationSummary);

  if (metric.durationMs >= 100) {
    console.debug(buildSettingsMetricLogMessage(metric, operationKey));
  }
}

function getSettingsOperationKey(metric: SettingsMetric): string {
  if (metric.type === 'ipc') {
    return metric.channel ? `ipc:${metric.channel}` : 'ipc:unknown';
  }
  if (metric.type === 'tabLoad') {
    return metric.tab ? `tabLoad:${metric.tab}` : 'tabLoad:unknown';
  }
  return metric.type;
}

function buildSettingsMetricLogMessage(metric: SettingsMetric, operationKey: string): string {
  const parts = [
    `[Performance] settings ${operationKey} took ${metric.durationMs}ms.`,
  ];
  if (metric.tab) {
    parts.push(`tab=${metric.tab}.`);
  }
  if (metric.success === false) {
    parts.push('success=false.');
  }
  if (metric.triggeredRuntimeStart === true) {
    parts.push('runtimeStart=true.');
  }
  if (metric.error) {
    parts.push(`error=${metric.error}.`);
  }
  return parts.join(' ');
}

export function measureDbOperation<T>(
  operation: DbMetricOperation,
  task: () => T,
  context: Omit<DbMetricInput, 'operation' | 'durationMs'> = {},
): T {
  const startedAt = performance.now();
  let result: T;
  try {
    result = task();
  } finally {
    recordDbOperation({
      ...context,
      operation,
      durationMs: performance.now() - startedAt,
    });
  }
  return result!;
}

export function setDbSlowThresholdForTesting(thresholdMs: number): void {
  dbSlowThresholdMs = thresholdMs;
}

export function resetPerformanceMetricsForTesting(): void {
  for (const key of Object.keys(startupTimings) as PerformanceTimingName[]) {
    delete startupTimings[key];
  }
  ipcByType.clear();
  ipcSessions.clear();
  dbByOperation.clear();
  slowDbOperations.length = 0;
  settingsMetrics.length = 0;
  settingsByType.clear();
  settingsByOperation.clear();
  totalIpcEvents = 0;
  totalIpcPayloadBytes = 0;
  maxIpcPayloadBytes = 0;
  maxMessageUpdatePayloadBytes = 0;
  dbOperationCount = 0;
  dbSlowThresholdMs = DEFAULT_DB_SLOW_THRESHOLD_MS;
  settingsMetricCount = 0;
}

export function getPerformanceSnapshot(
  metadata: PerformanceSnapshotMetadata = {},
): PerformanceSnapshot {
  const byType: PerformanceSnapshot['ipc']['byType'] = {};
  for (const [type, summary] of ipcByType.entries()) {
    byType[type] = { ...summary };
  }

  const byOperation: PerformanceSnapshot['db']['byOperation'] = {};
  for (const [operation, summary] of dbByOperation.entries()) {
    byOperation[operation] = {
      count: summary.count,
      totalDurationMs: Math.round(summary.totalDurationMs),
      maxDurationMs: Math.round(summary.maxDurationMs),
      slowCount: summary.slowCount,
    };
  }

  const sessions = Array.from(ipcSessions.entries()).map(([sessionId, summary]) => ({
    sessionId,
    eventCount: summary.eventCount,
    maxEventsPerSecond: summary.maxEventsPerSecond,
  }));

  const settingsByTypeSnapshot: PerformanceSnapshot['settings']['byType'] = {};
  for (const [type, summary] of settingsByType.entries()) {
    settingsByTypeSnapshot[type] = {
      count: summary.count,
      totalDurationMs: Math.round(summary.totalDurationMs),
      maxDurationMs: Math.round(summary.maxDurationMs),
    };
  }

  const settingsByOperationSnapshot: PerformanceSnapshot['settings']['byOperation'] = {};
  for (const [operation, summary] of settingsByOperation.entries()) {
    settingsByOperationSnapshot[operation] = {
      count: summary.count,
      totalDurationMs: Math.round(summary.totalDurationMs),
      maxDurationMs: Math.round(summary.maxDurationMs),
    };
  }

  return {
    sampledAt: new Date().toISOString(),
    uptimeMs: Math.round(performance.now() - processStartedAt),
    metadata,
    startupTimings: { ...startupTimings },
    ipc: {
      totalEvents: totalIpcEvents,
      totalPayloadBytes: totalIpcPayloadBytes,
      maxPayloadBytes: maxIpcPayloadBytes,
      maxMessageUpdatePayloadBytes,
      byType,
      sessions,
    },
    db: {
      totalOperations: dbOperationCount,
      slowThresholdMs: dbSlowThresholdMs,
      slowOperations: [...slowDbOperations],
      byOperation,
    },
    settings: {
      totalEvents: settingsMetricCount,
      recentEvents: [...settingsMetrics],
      byType: settingsByTypeSnapshot,
      byOperation: settingsByOperationSnapshot,
    },
  };
}
