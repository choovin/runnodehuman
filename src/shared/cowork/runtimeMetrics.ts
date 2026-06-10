import type {
  CoworkAgentEngine,
  RuntimeCallSource,
  RuntimeCallStatus,
} from './constants';

export interface RuntimeMetricsFilters {
  from?: number;
  to?: number;
  engine?: CoworkAgentEngine;
  modelId?: string;
  providerKey?: string;
  status?: RuntimeCallStatus;
  source?: RuntimeCallSource;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface RuntimeToolMetric {
  toolName: string;
  toolUseId: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  isError?: boolean;
}

export interface RuntimeCallRecord {
  id: string;
  sessionId: string;
  sessionTitle: string | null;
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
  status: RuntimeCallStatus;
  startedAt: number;
  firstOutputAt: number | null;
  lastOutputAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextTokens: number | null;
  tokensEstimated: boolean;
  outputChars: number;
  visibleOutputTokens: number | null;
  visibleOutputUpdates: number;
  toolCallCount: number;
  toolLatencyMs: number | null;
  agentSteps: number;
  estimatedCostUsd: number | null;
  error: string | null;
  metadata: {
    tools?: RuntimeToolMetric[];
    [key: string]: unknown;
  };
}

export interface RuntimeMetricsBreakdownItem {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  avgCompletionMs: number | null;
}

export interface RuntimeMetricsTimePoint {
  bucketStart: number;
  calls: number;
  completedCalls: number;
  errorCalls: number;
  inputTokens: number;
  outputTokens: number;
  avgCompletionMs: number | null;
  avgTtftMs: number | null;
}

export interface RuntimeMetricsSummary {
  totalCalls: number;
  completedCalls: number;
  errorCalls: number;
  stoppedCalls: number;
  runningCalls: number;
  successRate: number | null;
  avgCompletionMs: number | null;
  p95CompletionMs: number | null;
  avgTtftMs: number | null;
  avgTps: number | null;
  avgRuntimeTps: number | null;
  avgModelTps: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalContextTokens: number;
  estimatedTokenCalls: number;
  estimatedCostUsd: number | null;
  callsByEngine: RuntimeMetricsBreakdownItem[];
  callsByModel: RuntimeMetricsBreakdownItem[];
  timeSeries: RuntimeMetricsTimePoint[];
}

export interface RuntimeMetricsListResult {
  total: number;
  calls: RuntimeCallRecord[];
}

export interface RuntimeMetricsDetailResult {
  call: RuntimeCallRecord | null;
}

const CJK_RE = /[\u3400-\u9fff]/u;
const MIN_MEASURED_OUTPUT_WINDOW_MS = 250;

type ModelTpsProfile = {
  pattern: RegExp;
  min: number;
  max: number;
  baseline: number;
  runtimeLow: number;
  runtimeHigh: number;
};

const MODEL_TPS_PROFILES: ModelTpsProfile[] = [
  { pattern: /\bgpt[-_.\s]?5\.5\b/i, min: 120, max: 170, baseline: 145, runtimeLow: 8, runtimeHigh: 60 },
  { pattern: /\bgpt[-_.\s]?5(?:\b|[-_.\s])/i, min: 115, max: 155, baseline: 135, runtimeLow: 8, runtimeHigh: 55 },
  { pattern: /glm.*highspeed/i, min: 300, max: 350, baseline: 325, runtimeLow: 20, runtimeHigh: 90 },
  { pattern: /glm/i, min: 75, max: 115, baseline: 95, runtimeLow: 8, runtimeHigh: 45 },
  { pattern: /deepseek/i, min: 55, max: 95, baseline: 75, runtimeLow: 6, runtimeHigh: 40 },
  { pattern: /qwen/i, min: 65, max: 105, baseline: 85, runtimeLow: 6, runtimeHigh: 45 },
  { pattern: /(kimi|moonshot)/i, min: 55, max: 95, baseline: 75, runtimeLow: 6, runtimeHigh: 40 },
];

export const estimateTextTokensForRuntimeMetrics = (value: string): number => {
  if (!value.trim()) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of value) {
    if (/\s/u.test(char)) continue;
    if (CJK_RE.test(char)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
};

export const estimateVisibleOutputTokensFromChars = (outputChars: number | null | undefined): number | null => {
  if (!Number.isFinite(outputChars) || !outputChars || outputChars <= 0) return null;
  return Math.max(1, Math.ceil(outputChars / 4));
};

export const getVisibleOutputTokensForTps = (record: RuntimeCallRecord): number | null => {
  return record.visibleOutputTokens
    ?? estimateVisibleOutputTokensFromChars(record.outputChars)
    ?? record.outputTokens;
};

export const estimateModelTpsPrior = (record: RuntimeCallRecord): number | null => {
  return estimateModelTpsProfile(record)?.baseline ?? null;
};

const estimateModelTpsProfile = (record: RuntimeCallRecord): ModelTpsProfile | null => {
  const modelText = [record.modelId, record.modelName].filter(Boolean).join(' ');
  if (!modelText) return null;
  return MODEL_TPS_PROFILES.find((item) => item.pattern.test(modelText)) ?? null;
};

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const estimateModelTpsFromRuntime = (record: RuntimeCallRecord, runtimeTps: number | null): number | null => {
  const profile = estimateModelTpsProfile(record);
  if (!profile) return null;
  if (!runtimeTps || !Number.isFinite(runtimeTps)) return profile.baseline;
  const normalizedRuntime = clampNumber(
    (runtimeTps - profile.runtimeLow) / Math.max(profile.runtimeHigh - profile.runtimeLow, 1),
    0,
    1,
  );
  return profile.min + (profile.max - profile.min) * normalizedRuntime;
};

const calculateMeasuredOutputWindowMs = (record: RuntimeCallRecord): number | null => {
  if (record.visibleOutputUpdates < 2) return null;
  if (!record.firstOutputAt || !record.lastOutputAt || record.lastOutputAt <= record.firstOutputAt) return null;
  return Math.max(record.lastOutputAt - record.firstOutputAt, MIN_MEASURED_OUTPUT_WINDOW_MS);
};

export const calculateRuntimeTps = (record: RuntimeCallRecord): number | null => {
  const visibleOutputTokens = getVisibleOutputTokensForTps(record);
  if (!visibleOutputTokens) return null;
  const outputWindowMs = calculateMeasuredOutputWindowMs(record);
  if (!outputWindowMs) return null;
  const seconds = Math.max(outputWindowMs / 1000, MIN_MEASURED_OUTPUT_WINDOW_MS / 1000);
  return visibleOutputTokens / seconds;
};

export const calculateModelTps = (record: RuntimeCallRecord): number | null => {
  const visibleOutputTokens = getVisibleOutputTokensForTps(record);
  if (!visibleOutputTokens || !record.firstOutputAt) return null;
  const runtimeTps = calculateRuntimeTps(record);
  const estimatedModelTps = estimateModelTpsFromRuntime(record, runtimeTps);
  if (estimatedModelTps) return estimatedModelTps;
  const measuredWindowMs = calculateMeasuredOutputWindowMs(record);
  if (measuredWindowMs) {
    return visibleOutputTokens / Math.max(measuredWindowMs / 1000, MIN_MEASURED_OUTPUT_WINDOW_MS / 1000);
  }
  return estimateModelTpsPrior(record);
};
