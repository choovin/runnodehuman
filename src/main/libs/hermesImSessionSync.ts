import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  CoworkExecutionMode,
  CoworkImportedMessageInput,
  CoworkMessageType,
  CoworkStore,
} from '../coworkStore';
import type { IMStore } from '../im/imStore';
import type { Platform } from '../im/types';

const HermesIMMessageSource = {
  Gateway: 'hermes_gateway',
} as const;

const HermesIMPlatform = {
  Feishu: 'feishu',
} as const satisfies Record<string, Platform>;

const HERMES_IMPORTED_SESSION_PREFIX = 'hermes';
const HERMES_SESSION_IMPORT_LIMIT = 200;

interface HermesIMSessionSyncDeps {
  coworkStore: CoworkStore;
  imStore: IMStore;
  cwd: string;
  systemPrompt?: string;
  executionMode?: CoworkExecutionMode;
  agentId?: string;
}

export interface HermesIMSessionSyncResult {
  changed: boolean;
  importedSessions: number;
  importedMessages: number;
  latestUpdatedAt: number;
  skippedReason?: string;
}

interface HermesSessionsFileEntry {
  session_key?: unknown;
  session_id?: unknown;
  display_name?: unknown;
  platform?: unknown;
  chat_type?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  origin?: unknown;
}

interface HermesStateSessionRow {
  id: string;
  source: string | null;
  user_id: string | null;
  model: string | null;
  title: string | null;
  started_at: number | string | null;
  ended_at: number | string | null;
  message_count: number | null;
}

interface HermesStateMessageRow {
  id: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  timestamp: number | string | null;
  platform_message_id: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stringValue = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const timestampToMs = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return timestampToMs(numeric, fallback);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const stableFallbackTimestamp = (seed: string): number => {
  const digest = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
  return 1_700_000_000_000 + (Number.parseInt(digest, 16) % 100_000_000_000);
};

const importedCoworkSessionId = (hermesSessionId: string): string => (
  `${HERMES_IMPORTED_SESSION_PREFIX}-${hermesSessionId}`
);

const importedCoworkMessageId = (hermesSessionId: string, hermesMessageId: string): string => {
  const digest = crypto
    .createHash('sha1')
    .update(`${hermesSessionId}:${hermesMessageId}`)
    .digest('hex')
    .slice(0, 20);
  return `${HERMES_IMPORTED_SESSION_PREFIX}-msg-${digest}`;
};

const shortenDisplayId = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return trimmed.slice(-12);
};

const readHermesSessionsFile = (filePath: string): Map<string, HermesSessionsFileEntry> => {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return new Map();
  }

  const bySessionId = new Map<string, HermesSessionsFileEntry>();
  for (const [sessionKey, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue;
    const sessionId = stringValue(entry.session_id);
    if (!sessionId) continue;
    bySessionId.set(sessionId, {
      ...entry,
      session_key: entry.session_key ?? sessionKey,
    });
  }
  return bySessionId;
};

const getOriginRecord = (entry: HermesSessionsFileEntry | undefined): Record<string, unknown> => {
  if (!entry || !isRecord(entry.origin)) return {};
  return entry.origin;
};

const resolveConversationId = (
  session: HermesStateSessionRow,
  entry: HermesSessionsFileEntry | undefined,
): string => {
  const origin = getOriginRecord(entry);
  return stringValue(origin.chat_id)
    || stringValue(entry?.session_key)
    || stringValue(entry?.display_name)
    || session.user_id
    || session.id;
};

const resolveTitle = (
  session: HermesStateSessionRow,
  entry: HermesSessionsFileEntry | undefined,
): string => {
  if (session.title?.trim()) {
    return `[飞书] ${session.title.trim()}`;
  }
  const origin = getOriginRecord(entry);
  const display = stringValue(origin.chat_name)
    || stringValue(entry?.display_name)
    || resolveConversationId(session, entry);
  return `[飞书] ${shortenDisplayId(display)}`;
};

const normalizeMessageType = (role: string | null): CoworkMessageType | null => {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }
  if (role === 'tool') {
    return 'tool_result';
  }
  return null;
};

const readHermesMessages = (
  db: Database.Database,
  hermesSessionId: string,
  fallbackTimestamp: number,
): CoworkImportedMessageInput[] => {
  const rows = db
    .prepare(
      `
      SELECT id, role, content, tool_name, timestamp, platform_message_id
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `,
    )
    .all(hermesSessionId) as HermesStateMessageRow[];

  const messages: CoworkImportedMessageInput[] = [];
  for (const [index, row] of rows.entries()) {
    const type = normalizeMessageType(row.role);
    if (!type) continue;
    if (row.role === 'session_meta') continue;
    const content = row.content || '';
    if (!content.trim() && type !== 'tool_result') continue;

    messages.push({
      id: importedCoworkMessageId(hermesSessionId, row.id),
      type,
      content,
      timestamp: timestampToMs(row.timestamp, fallbackTimestamp + index),
      metadata: {
        isStreaming: false,
        isFinal: true,
        source: HermesIMMessageSource.Gateway,
        hermesSessionId,
        hermesMessageId: row.id,
        platform: HermesIMPlatform.Feishu,
        platformMessageId: row.platform_message_id || undefined,
        toolName: row.tool_name || undefined,
      },
    });
  }
  return messages;
};

const syncIMMapping = (
  imStore: IMStore,
  conversationId: string,
  coworkSessionId: string,
  agentId: string,
): boolean => {
  const mapping = imStore.getSessionMapping(conversationId, HermesIMPlatform.Feishu);
  if (!mapping) {
    imStore.createSessionMapping(conversationId, HermesIMPlatform.Feishu, coworkSessionId, agentId);
    return true;
  }
  if (mapping.coworkSessionId !== coworkSessionId || mapping.agentId !== agentId) {
    imStore.updateSessionMappingTarget(conversationId, HermesIMPlatform.Feishu, coworkSessionId, agentId);
    return true;
  }
  return false;
};

export const syncHermesIMSessions = (deps: HermesIMSessionSyncDeps): HermesIMSessionSyncResult => {
  const hermesHome = path.join(os.homedir(), '.hermes');
  const stateDbPath = path.join(hermesHome, 'state.db');
  const sessionsFilePath = path.join(hermesHome, 'sessions', 'sessions.json');

  if (!fs.existsSync(stateDbPath)) {
    return {
      changed: false,
      importedSessions: 0,
      importedMessages: 0,
      latestUpdatedAt: 0,
      skippedReason: 'Hermes state database does not exist.',
    };
  }

  const sessionFileEntries = readHermesSessionsFile(sessionsFilePath);
  const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const sessions = db
      .prepare(
        `
        SELECT id, source, user_id, model, title, started_at, ended_at, message_count
        FROM sessions
        WHERE source = ?
        ORDER BY started_at DESC
        LIMIT ?
      `,
      )
      .all(HermesIMPlatform.Feishu, HERMES_SESSION_IMPORT_LIMIT) as HermesStateSessionRow[];

    let changed = false;
    let importedSessions = 0;
    let importedMessages = 0;
    let latestUpdatedAt = 0;

    for (const session of sessions) {
      const entry = sessionFileEntries.get(session.id);
      const sessionFallbackTimestamp = timestampToMs(
        session.started_at,
        timestampToMs(session.ended_at, stableFallbackTimestamp(session.id)),
      );
      const messages = readHermesMessages(db, session.id, sessionFallbackTimestamp);
      if (messages.length === 0) continue;

      const createdAt = timestampToMs(session.started_at, messages[0]?.timestamp || Date.now());
      const messageUpdatedAt = messages.reduce((max, message) => Math.max(max, message.timestamp), createdAt);
      const updatedAt = Math.max(timestampToMs(session.ended_at, messageUpdatedAt), messageUpdatedAt);
      latestUpdatedAt = Math.max(latestUpdatedAt, updatedAt);
      const coworkSessionId = importedCoworkSessionId(session.id);
      const conversationId = resolveConversationId(session, entry);
      const agentId = deps.agentId || 'main';

      const sessionChanged = deps.coworkStore.upsertImportedSession({
        id: coworkSessionId,
        title: resolveTitle(session, entry),
        claudeSessionId: session.id,
        status: 'completed',
        cwd: deps.cwd,
        systemPrompt: deps.systemPrompt || '',
        executionMode: deps.executionMode || 'local',
        activeSkillIds: [],
        agentId,
        createdAt,
        updatedAt,
      });
      const messagesChanged = deps.coworkStore.replaceImportedSessionMessages(coworkSessionId, messages);
      const mappingChanged = syncIMMapping(deps.imStore, conversationId, coworkSessionId, agentId);

      changed = changed || sessionChanged || messagesChanged || mappingChanged;
      importedSessions++;
      importedMessages += messages.length;
    }

    return { changed, importedSessions, importedMessages, latestUpdatedAt };
  } finally {
    db.close();
  }
};
