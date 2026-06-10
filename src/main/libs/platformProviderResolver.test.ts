import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkAgentEngine } from '../../shared/cowork/constants';
import {
  clearPlatformProviderResolver,
  getPlatformProviderResolver,
  resolveApiConfigForEngine,
  setPlatformProviderResolver,
} from './platformProviderResolver';

// Mock claudeSettings so resolveRawApiConfig is controllable from tests
vi.mock('./claudeSettings', () => ({
  resolveRawApiConfig: vi.fn(),
}));

import { resolveRawApiConfig } from './claudeSettings';

const mockedResolveRawApiConfig = vi.mocked(resolveRawApiConfig);

describe('platformProviderResolver', () => {
  beforeEach(() => {
    clearPlatformProviderResolver();
    mockedResolveRawApiConfig.mockReset();
  });

  afterEach(() => {
    clearPlatformProviderResolver();
  });

  describe('setter', () => {
    test('starts cleared', () => {
      expect(getPlatformProviderResolver()).toBeNull();
    });

    test('setPlatformProviderResolver stores the function', () => {
      const fn = async () => null;
      setPlatformProviderResolver(fn);
      expect(getPlatformProviderResolver()).toBe(fn);
    });

    test('clearPlatformProviderResolver resets to null', () => {
      setPlatformProviderResolver(async () => null);
      clearPlatformProviderResolver();
      expect(getPlatformProviderResolver()).toBeNull();
    });
  });

  describe('resolveApiConfigForEngine', () => {
    test('returns preFetched when provided (no resolver needed)', async () => {
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
        preFetched: { baseUrl: 'https://prefetched/v1', apiKey: 'pf-key' },
      });
      expect(cfg).toEqual({
        apiKey: 'pf-key',
        baseURL: 'https://prefetched/v1',
        model: 'claude-sonnet-4-5',
        apiType: 'openai',
      });
      expect(mockedResolveRawApiConfig).not.toHaveBeenCalled();
    });

    test('prefers preFetched over platform-provider resolver', async () => {
      setPlatformProviderResolver(async () => ({
        apiKey: 'platform-key',
        baseURL: 'https://platform/v1',
        model: 'should-not-be-used',
        apiType: 'openai',
      }));
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
        preFetched: { baseUrl: 'https://prefetched/v1', apiKey: 'pf-key' },
      });
      expect(cfg?.apiKey).toBe('pf-key');
    });

    test('falls back to platform-provider resolver when no preFetched', async () => {
      setPlatformProviderResolver(async () => ({
        apiKey: 'platform-key',
        baseURL: 'https://platform/v1',
        model: 'claude-sonnet-4-5',
        apiType: 'openai',
      }));
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
      });
      expect(cfg).toEqual({
        apiKey: 'platform-key',
        baseURL: 'https://platform/v1',
        model: 'claude-sonnet-4-5',
        apiType: 'openai',
      });
      expect(mockedResolveRawApiConfig).not.toHaveBeenCalled();
    });

    test('skips platform-provider when preferUserConfig is true', async () => {
      setPlatformProviderResolver(async () => ({
        apiKey: 'platform-key',
        baseURL: 'https://platform/v1',
        model: 'should-not-be-used',
        apiType: 'openai',
      }));
      mockedResolveRawApiConfig.mockResolvedValue({
        config: {
          apiKey: 'user-key',
          baseURL: 'https://user/v1',
          model: 'user-model',
          apiType: 'anthropic',
        },
      });
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
        preferUserConfig: true,
      });
      expect(cfg).toEqual({
        apiKey: 'user-key',
        baseURL: 'https://user/v1',
        model: 'user-model',
        apiType: 'anthropic',
      });
    });

    test('falls back to user config when platform-provider returns null', async () => {
      setPlatformProviderResolver(async () => null);
      mockedResolveRawApiConfig.mockResolvedValue({
        config: {
          apiKey: 'user-key',
          baseURL: 'https://user/v1',
          model: 'user-model',
        },
      });
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
      });
      expect(cfg?.apiKey).toBe('user-key');
    });

    test('returns null when nothing has a value', async () => {
      setPlatformProviderResolver(async () => null);
      mockedResolveRawApiConfig.mockResolvedValue({ config: null });
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
      });
      expect(cfg).toBeNull();
    });

    test('returns null when no resolver is set and user config is null', async () => {
      mockedResolveRawApiConfig.mockResolvedValue({ config: null });
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
      });
      expect(cfg).toBeNull();
    });

    test('falls back to user config when platform-provider throws', async () => {
      setPlatformProviderResolver(async () => {
        throw new Error('boom');
      });
      mockedResolveRawApiConfig.mockResolvedValue({
        config: {
          apiKey: 'user-key',
          baseURL: 'https://user/v1',
          model: 'user-model',
        },
      });
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.ClaudeCode,
      });
      expect(cfg?.apiKey).toBe('user-key');
    });

    test('per-engine model defaults are applied from preFetched path', async () => {
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.Codex,
        preFetched: { baseUrl: 'https://x/v1', apiKey: 'k' },
      });
      expect(cfg?.model).toBe('gpt-5.4');
      expect(cfg?.apiType).toBe('openai');
    });

    test('engines without a default get empty model (engine chooses)', async () => {
      const cfg = await resolveApiConfigForEngine({
        engine: CoworkAgentEngine.OpenClaw,
        preFetched: { baseUrl: 'https://x/v1', apiKey: 'k' },
      });
      expect(cfg?.model).toBe('');
    });

    test('platform-provider resolver receives the engine parameter', async () => {
      const resolver = vi.fn(async () => null);
      setPlatformProviderResolver(resolver);
      await resolveApiConfigForEngine({ engine: CoworkAgentEngine.Hermes });
      expect(resolver).toHaveBeenCalledWith(CoworkAgentEngine.Hermes);
    });
  });
});
