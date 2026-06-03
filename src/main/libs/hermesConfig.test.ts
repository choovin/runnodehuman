import { describe, expect, test } from 'vitest';

import {
  buildHermesDotenv,
  buildHermesEnvForWesightModel,
  buildHermesFeishuEnvForInstances,
  buildHermesRuntimeEnvForLocalCli,
  DEFAULT_HERMES_MODEL,
  HERMES_WESIGHT_FEISHU_ENV_BLOCK,
  listHermesModelProviders,
  mergeHermesConfigForWesightModel,
  mergeHermesManagedDotenvBlock,
  parseHermesConfigText,
  parseHermesDotenvText,
  summarizeHermesSettingsConfig,
} from './hermesConfig';

describe('hermesConfig', () => {
  test('empty config exposes a default current model', () => {
    const records = listHermesModelProviders({});

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'custom',
      model: DEFAULT_HERMES_MODEL,
      isCurrent: true,
    });
  });

  test('invalid yaml parses as an empty config', () => {
    expect(parseHermesConfigText('model: [')).toEqual({});
  });

  test('lists local model from config and env', () => {
    const records = listHermesModelProviders(
      {
        model: {
          provider: 'kimi',
          default: 'k2.6',
          base_url: 'https://api.moonshot.cn/v1',
        },
      },
      {
        HERMES_INFERENCE_API_KEY: 'sk-kimi',
      },
    );

    expect(records[0]).toMatchObject({
      name: 'Kimi',
      provider: 'kimi',
      model: 'k2.6',
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      isCurrent: true,
    });
  });

  test('merges WeSight model while preserving unknown fields', () => {
    const merged = mergeHermesConfigForWesightModel(
      {
        workspace: { pinned: true },
        model: {
          provider: 'old',
          default: 'old-model',
          keep: true,
        },
        terminal: {
          shell: '/bin/zsh',
        },
      },
      {
        apiKey: 'sk-new',
        baseURL: 'https://api.example.com/v1',
        model: 'my-model',
        apiType: 'openai',
      },
      {
        workingDirectory: '/tmp/project',
      },
    );

    expect(merged.workspace).toEqual({ pinned: true });
    expect(merged.model).toMatchObject({
      provider: 'custom',
      default: 'my-model',
      base_url: 'https://api.example.com/v1',
      keep: true,
    });
    expect(merged.terminal).toMatchObject({
      shell: '/bin/zsh',
      backend: 'local',
      cwd: '/tmp/project',
    });
  });

  test('maps Anthropic model into Hermes config and env', () => {
    const merged = mergeHermesConfigForWesightModel(
      {},
      {
        apiKey: 'sk-ant',
        baseURL: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        apiType: 'anthropic',
      },
    );
    const env = buildHermesEnvForWesightModel({
      apiKey: 'sk-ant',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiType: 'anthropic',
    });

    expect(merged.model).toMatchObject({
      provider: 'anthropic',
      default: 'claude-sonnet-4-5',
    });
    expect(env).toMatchObject({
      HERMES_INFERENCE_PROVIDER: 'anthropic',
      HERMES_INFERENCE_API_KEY: 'sk-ant',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });

  test('maps BigModel Anthropic-compatible endpoint to Z.AI provider', () => {
    const config = {
      apiKey: 'sk-glm',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.1-highspeed',
      apiType: 'anthropic' as const,
    };
    const merged = mergeHermesConfigForWesightModel({}, config);
    const env = buildHermesEnvForWesightModel(config);

    expect(merged.model).toMatchObject({
      provider: 'zai',
      default: 'glm-5.1-highspeed',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_mode: 'anthropic_messages',
    });
    expect(env).toMatchObject({
      HERMES_INFERENCE_PROVIDER: 'zai',
      HERMES_INFERENCE_MODEL: 'glm-5.1-highspeed',
      HERMES_INFERENCE_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      GLM_API_KEY: 'sk-glm',
      ZAI_API_KEY: 'sk-glm',
      Z_AI_API_KEY: 'sk-glm',
      GLM_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  test('normalizes local Hermes BigModel Anthropic config at runtime', () => {
    const env = buildHermesRuntimeEnvForLocalCli(
      {
        model: {
          provider: 'anthropic',
          default: 'glm-5.1-highspeed',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
        },
      },
      {
        HERMES_INFERENCE_API_KEY: 'sk-glm',
        ANTHROPIC_API_KEY: 'sk-glm',
      },
    );

    expect(env).toMatchObject({
      HERMES_INFERENCE_PROVIDER: 'zai',
      HERMES_INFERENCE_MODEL: 'glm-5.1-highspeed',
      HERMES_INFERENCE_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      HERMES_INFERENCE_API_KEY: 'sk-glm',
      GLM_API_KEY: 'sk-glm',
      ZAI_API_KEY: 'sk-glm',
      Z_AI_API_KEY: 'sk-glm',
      GLM_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    });
  });

  test('round trips dotenv and summarizes stored settings', () => {
    const env = parseHermesDotenvText(buildHermesDotenv({
      HERMES_INFERENCE_API_KEY: 'sk-local',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
    }));
    const summary = summarizeHermesSettingsConfig({
      config: {
        model: {
          provider: 'custom',
          default: 'local-model',
        },
      },
      env,
    });

    expect(summary).toEqual({
      apiKey: 'sk-local',
      baseUrl: 'https://api.example.com/v1',
      model: 'local-model',
    });
  });

  test('merges managed dotenv block while preserving user values', () => {
    const merged = mergeHermesManagedDotenvBlock(
      'OPENAI_API_KEY="sk-user"\n# keep me\n',
      HERMES_WESIGHT_FEISHU_ENV_BLOCK,
      {
        FEISHU_APP_ID: 'cli_123',
        FEISHU_APP_SECRET: 'secret',
      },
    );

    expect(merged).toContain('OPENAI_API_KEY="sk-user"');
    expect(merged).toContain('# keep me');
    expect(merged).toContain('# >>> WeSight managed: wesight-feishu');
    expect(parseHermesDotenvText(merged)).toMatchObject({
      OPENAI_API_KEY: 'sk-user',
      FEISHU_APP_ID: 'cli_123',
      FEISHU_APP_SECRET: 'secret',
    });
  });

  test('removes managed dotenv block when env is empty', () => {
    const merged = mergeHermesManagedDotenvBlock(
      [
        'OPENAI_API_KEY="sk-user"',
        '# >>> WeSight managed: wesight-feishu',
        'FEISHU_APP_ID="cli_old"',
        '# <<< WeSight managed: wesight-feishu',
        '',
      ].join('\n'),
      HERMES_WESIGHT_FEISHU_ENV_BLOCK,
      {},
    );

    expect(merged).toBe('OPENAI_API_KEY="sk-user"\n');
  });

  test('builds Hermes Feishu env for one enabled instance', () => {
    const result = buildHermesFeishuEnvForInstances([
      {
        enabled: true,
        appId: ' cli_123 ',
        appSecret: ' secret ',
        domain: 'feishu',
        dmPolicy: 'allowlist',
        allowFrom: ['ou_1', ''],
        groupPolicy: 'allowlist',
        groupAllowFrom: [],
        groups: {},
        historyLimit: 50,
        replyMode: 'auto',
        mediaMaxMb: 30,
        debug: false,
        instanceId: 'inst_1',
        instanceName: 'Feishu Bot',
      },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.env).toMatchObject({
      FEISHU_APP_ID: 'cli_123',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_CONNECTION_MODE: 'websocket',
      FEISHU_ALLOW_ALL_USERS: 'false',
      FEISHU_ALLOWED_USERS: 'ou_1',
      FEISHU_GROUP_POLICY: 'allowlist',
    });
  });

  test('blocks multiple enabled Hermes Feishu instances', () => {
    const base = {
      enabled: true,
      appId: 'cli_123',
      appSecret: 'secret',
      domain: 'feishu',
      dmPolicy: 'open',
      allowFrom: [],
      groupPolicy: 'open',
      groupAllowFrom: [],
      groups: {},
      historyLimit: 50,
      replyMode: 'auto',
      mediaMaxMb: 30,
      debug: false,
      instanceName: 'Feishu Bot',
    } as const;
    const result = buildHermesFeishuEnvForInstances([
      { ...base, instanceId: 'inst_1' },
      { ...base, instanceId: 'inst_2' },
    ]);

    expect(result.env).toEqual({});
    expect(result.error).toContain('one enabled Feishu bot');
  });
});
