/* eslint-env node */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const { app } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist-electron', 'src');

if (!fs.existsSync(path.join(distRoot, 'main', 'libs', 'claudeSettings.js'))) {
  console.error(`Compiled Electron files were not found under ${distRoot}. Run: npx tsc -p electron-tsconfig.json`);
  process.exit(1);
}

const {
  CoworkAgentEngine,
  ExternalAgentConfigSource,
} = require(path.join(distRoot, 'shared', 'cowork', 'constants.js'));
const { ProviderRegistry } = require(path.join(distRoot, 'shared', 'providers', 'constants.js'));
const { SqliteStore } = require(path.join(distRoot, 'main', 'sqliteStore.js'));
const { CoworkStore } = require(path.join(distRoot, 'main', 'coworkStore.js'));
const {
  startCoworkOpenAICompatProxy,
  stopCoworkOpenAICompatProxy,
} = require(path.join(distRoot, 'main', 'libs', 'coworkOpenAICompatProxy.js'));
const { setStoreGetter } = require(path.join(distRoot, 'main', 'libs', 'claudeSettings.js'));
const { ExternalCliRuntimeAdapter } = require(path.join(
  distRoot,
  'main',
  'libs',
  'agentEngine',
  'externalCliRuntimeAdapter.js',
));

const providerIds = parseCsv(process.env.WESIGHT_SMOKE_PROVIDERS || 'deepseek,minimax');
const formats = parseCsv(process.env.WESIGHT_SMOKE_FORMATS || 'anthropic,openai');
const engines = parseCsv(process.env.WESIGHT_SMOKE_ENGINES || 'claude,codex');
const timeoutMs = Number(process.env.WESIGHT_SMOKE_TIMEOUT_MS || 5 * 60 * 1000);
const keepTemp = process.env.WESIGHT_SMOKE_KEEP_TEMP === '1';
const listProvidersOnly = process.env.WESIGHT_SMOKE_LIST_PROVIDERS === '1';
const prompt = process.env.WESIGHT_SMOKE_PROMPT || [
  'You are running a WeSight external CLI smoke test.',
  'Do not create, edit, delete, or inspect files.',
  'Return only a compact JSON object with these keys:',
  'marker, engine, provider, apiFormat, note.',
  'The marker value must be exactly "WESIGHT_SMOKE_OK".',
  'The note value must be one short Chinese sentence.',
].join('\n');

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePathForDisplay(value) {
  return value.replace(/\\/g, '/');
}

function readJsonValueFromDb(dbPath, key) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashLocalCliConfigs() {
  const home = os.homedir();
  return {
    claudeSettings: hashFile(path.join(home, '.claude', 'settings.json')),
    codexConfig: hashFile(path.join(home, '.codex', 'config.toml')),
    codexAuth: hashFile(path.join(home, '.codex', 'auth.json')),
  };
}

function compareHashes(before, after) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [key, before[key] === after[key]]),
  );
}

function buildOfficialUserDataPath() {
  return path.join(app.getPath('appData'), 'WeSight');
}

function buildProviderConfig(appConfig, providerId, apiFormat) {
  const provider = appConfig.providers?.[providerId];
  if (!provider) {
    throw new Error(`Provider ${providerId} is not configured in app_config.`);
  }
  if (!provider.apiKey?.trim() && providerId !== 'ollama') {
    throw new Error(`Provider ${providerId} is missing an API key.`);
  }
  const models = Array.isArray(provider.models)
    ? provider.models.filter((model) => typeof model?.id === 'string' && model.id.trim())
    : [];
  if (models.length === 0) {
    throw new Error(`Provider ${providerId} has no configured models.`);
  }

  const currentModel = appConfig.model?.defaultModel;
  const preferred = provider.models.find((model) => model.id === currentModel);
  const model = preferred?.id || models[0].id;
  const switchableBaseUrl = ProviderRegistry.getSwitchableBaseUrl(providerId, apiFormat);
  const baseUrl = switchableBaseUrl || provider.baseUrl;
  if (!baseUrl?.trim()) {
    throw new Error(`Provider ${providerId} has no ${apiFormat} base URL.`);
  }

  const nextProvider = {
    ...provider,
    enabled: true,
    apiFormat,
    baseUrl,
    codingPlanEnabled: false,
    models,
  };
  return {
    appConfig: {
      ...appConfig,
      model: {
        ...(appConfig.model || {}),
        defaultModel: model,
        defaultModelProvider: providerId,
      },
      providers: {
        [providerId]: nextProvider,
      },
    },
    model,
    baseUrl,
    wasEnabled: Boolean(provider.enabled),
  };
}

function createRuntime(engine, coworkStore) {
  return new ExternalCliRuntimeAdapter({
    engine: engine === 'claude' ? CoworkAgentEngine.ClaudeCode : CoworkAgentEngine.Codex,
    store: coworkStore,
  });
}

async function runRuntimeCase({ engine, providerId, apiFormat, tempRoot, tempStore, coworkStore }) {
  const workspace = path.join(tempRoot, 'workspace', `${providerId}-${apiFormat}-${engine}`);
  fs.mkdirSync(workspace, { recursive: true });
  const session = coworkStore.createSession(
    `Smoke ${engine} ${providerId} ${apiFormat}`,
    workspace,
    '',
    'local',
    [],
    'main',
  );
  const runtime = createRuntime(engine, coworkStore);
  const events = [];
  const errors = [];
  let complete = false;

  runtime.on('message', (_sessionId, message) => {
    events.push({ type: 'message', messageType: message.type, chars: message.content.length });
  });
  runtime.on('messageUpdate', (_sessionId, _messageId, content) => {
    events.push({ type: 'messageUpdate', chars: content.length });
  });
  runtime.on('complete', () => {
    complete = true;
  });
  runtime.on('error', (_sessionId, error) => {
    errors.push(error);
  });

  const runPrompt = [
    prompt,
    '',
    `Smoke metadata: engine=${engine}; provider=${providerId}; apiFormat=${apiFormat}.`,
  ].join('\n');

  const runPromise = runtime.startSession(session.id, runPrompt, {
    systemPrompt: 'You are a smoke-test responder. Do not use tools. Do not modify files.',
    runtimeSnapshot: {
      configSource: ExternalAgentConfigSource.WesightModel,
      modelId: tempStore.get('app_config')?.model?.defaultModel,
      providerKey: providerId,
      providerName: providerId,
    },
  });
  await withTimeout(runPromise, timeoutMs, `${engine}/${providerId}/${apiFormat} timed out`);

  const finalSession = coworkStore.getSession(session.id);
  const assistantOutput = (finalSession?.messages || [])
    .filter((message) => message.type === 'assistant')
    .map((message) => message.content)
    .join('\n');
  const systemOutput = (finalSession?.messages || [])
    .filter((message) => message.type === 'system')
    .map((message) => message.content)
    .join('\n');

  return {
    engine,
    provider: providerId,
    apiFormat,
    status: finalSession?.status || 'missing',
    complete,
    assistantChars: assistantOutput.length,
    hasMarker: assistantOutput.includes('WESIGHT_SMOKE_OK'),
    errors,
    systemTail: systemOutput.slice(-1000),
    eventCount: events.length,
  };
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run() {
  app.setName('WeSight');
  await app.whenReady();

  const officialUserDataPath = process.env.WESIGHT_SMOKE_USER_DATA || buildOfficialUserDataPath();
  const officialDbPath = path.join(officialUserDataPath, 'wesight.sqlite');
  if (!fs.existsSync(officialDbPath)) {
    throw new Error(`WeSight DB not found: ${officialDbPath}`);
  }
  const sourceAppConfig = readJsonValueFromDb(officialDbPath, 'app_config');
  if (!sourceAppConfig?.providers) {
    throw new Error(`app_config.providers not found in ${officialDbPath}`);
  }

  if (listProvidersOnly) {
    console.log(JSON.stringify({
      officialDbPath: normalizePathForDisplay(officialDbPath),
      providers: Object.entries(sourceAppConfig.providers).map(([key, provider]) => ({
        key,
        enabled: Boolean(provider?.enabled),
        apiFormat: provider?.apiFormat || null,
        hasApiKey: Boolean(provider?.apiKey && String(provider.apiKey).trim()),
        baseUrl: provider?.baseUrl || '',
        modelCount: Array.isArray(provider?.models) ? provider.models.length : 0,
        models: Array.isArray(provider?.models)
          ? provider.models.map((model) => model?.id).filter(Boolean).slice(0, 8)
          : [],
      })),
    }, null, 2));
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-agent-cli-smoke-'));
  const tempUserData = path.join(tempRoot, 'userData');
  fs.mkdirSync(tempUserData, { recursive: true });
  app.setPath('userData', tempUserData);

  const localHashesBefore = hashLocalCliConfigs();
  const sqliteStore = SqliteStore.create(tempUserData);
  const coworkStore = new CoworkStore(sqliteStore.getDatabase());
  setStoreGetter(() => sqliteStore);

  const results = [];
  try {
    await startCoworkOpenAICompatProxy();
    coworkStore.setConfig({
      workingDirectory: path.join(tempRoot, 'workspace'),
      claudeCodeConfigSource: ExternalAgentConfigSource.WesightModel,
      codexConfigSource: ExternalAgentConfigSource.WesightModel,
    });

    for (const providerId of providerIds) {
      for (const apiFormat of formats) {
        let providerCase;
        try {
          providerCase = buildProviderConfig(sourceAppConfig, providerId, apiFormat);
        } catch (error) {
          results.push({
            provider: providerId,
            apiFormat,
            status: 'blocked',
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        sqliteStore.set('app_config', providerCase.appConfig);

        for (const engine of engines) {
          try {
            const result = await runRuntimeCase({
              engine,
              providerId,
              apiFormat,
              tempRoot,
              tempStore: sqliteStore,
              coworkStore,
            });
            results.push({
              ...result,
              model: providerCase.model,
              configuredBaseUrl: providerCase.baseUrl,
              providerWasEnabled: providerCase.wasEnabled,
            });
          } catch (error) {
            results.push({
              engine,
              provider: providerId,
              apiFormat,
              model: providerCase.model,
              configuredBaseUrl: providerCase.baseUrl,
              providerWasEnabled: providerCase.wasEnabled,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  } finally {
    stopCoworkOpenAICompatProxy();
    sqliteStore.close();
    setStoreGetter(() => null);
  }

  const localHashesAfter = hashLocalCliConfigs();
  const summary = {
    ok: results.every((result) => (
      result.status === 'completed'
      && result.complete === true
      && result.hasMarker === true
    )),
    officialDbPath: normalizePathForDisplay(officialDbPath),
    tempRoot: normalizePathForDisplay(tempRoot),
    localCliConfigHashesUnchanged: compareHashes(localHashesBefore, localHashesAfter),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!keepTemp) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to remove temp smoke directory ${tempRoot}:`, error);
    }
  }

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
  });
