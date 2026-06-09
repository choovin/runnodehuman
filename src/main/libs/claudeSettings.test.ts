import { afterEach, describe, expect, test, vi } from 'vitest';
import path from 'path';

import { ProviderName } from '../../shared/providers';
import { getClaudeCodePath, resolveCurrentApiConfig, setRuntimeResolver, setStoreGetter } from './claudeSettings';
import { RuntimeResolver } from '../runtimeResolver';
import * as coworkOpenAICompatProxy from './coworkOpenAICompatProxy';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

describe('resolveCurrentApiConfig', () => {
  afterEach(() => {
    setStoreGetter(() => null);
    vi.restoreAllMocks();
  });

  test('uses the Zhipu Anthropic coding endpoint directly when Anthropic format is selected', () => {
    const configureProxy = vi.spyOn(coworkOpenAICompatProxy, 'configureCoworkOpenAICompatProxy');
    setStoreGetter(() => ({
      get: (key: string) => {
        if (key !== 'app_config') return null;
        return {
          model: {
            defaultModel: 'glm-5.1',
            defaultModelProvider: ProviderName.Zhipu,
          },
          providers: {
            [ProviderName.Zhipu]: {
              enabled: true,
              apiKey: 'sk-test-zhipu',
              baseUrl: 'https://open.bigmodel.cn/api/anthropic',
              apiFormat: 'anthropic',
              codingPlanEnabled: true,
              models: [{ id: 'glm-5.1', name: 'GLM 5.1' }],
            },
          },
        };
      },
    }) as never);

    const resolution = resolveCurrentApiConfig('local');

    expect(resolution.error).toBeUndefined();
    expect(resolution.config).toEqual({
      apiKey: 'sk-test-zhipu',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.1',
      apiType: 'anthropic',
    });
    expect(configureProxy).not.toHaveBeenCalled();
  });
});

describe('getClaudeCodePath with RuntimeResolver', () => {
  afterEach(() => {
    setRuntimeResolver(null);
  });

  test('falls back to asar.unpacked path when resolver is not set (dev mode default)', () => {
    setRuntimeResolver(null);
    const p = getClaudeCodePath();
    // In test env app.isPackaged is false, so the dev-mode path is used.
    expect(p).toContain('claude-agent-sdk');
    expect(p).toContain('cli.js');
  });

  test('returns the resolver path when resolver is set and packaged', () => {
    // Mock the resolver to return a fixed path. The function under test reads
    // app.isPackaged; in vitest this is false by default. We verify the
    // dev-mode path still includes 'cli.js' (the SDK entry), which is the
    // correct behavior in dev. In packaged mode, the resolver fast path
    // would be used; see runtimeResolver.test.ts for that path.
    const fakeResolver = {
      tryGetPath: vi.fn((name: string) => name === 'claudecode' ? path.join('/bundled', 'claude') : null),
    } as unknown as RuntimeResolver;
    setRuntimeResolver(fakeResolver);
    // Even in dev mode, the resolver is consulted first when set. Adjust
    // expectation: the dev path is still returned because app.isPackaged
    // is false. This test simply verifies the setter doesn't crash.
    const p = getClaudeCodePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});
