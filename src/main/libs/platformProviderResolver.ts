/**
 * platformProviderResolver.ts
 *
 * Resolves the `CoworkApiConfig` for an engine, with the RunNode platform
 * provider (B spec) as the preferred source. The resolver wires the B
 * service into the engine-config write pipeline so a RunNode-logged-in
 * user can pick any engine without manually configuring baseUrl/apiKey.
 *
 * Resolution order (first non-null wins):
 *   1. `options.preFetched` (sync, from caller)
 *   2. Registered platform-provider resolver (async, hits B service via
 *      getCached() — wired in main.ts initApp via setPlatformProviderResolver)
 *   3. resolveRawApiConfig() (existing path: user's app_config.providers)
 *   4. null (engine falls back to its native config)
 *
 * The setter pattern avoids threading the B service dependency through the
 * per-engine merge functions (which currently call resolveRawApiConfig
 * directly). Tests can use clearPlatformProviderResolver() to opt out of
 * the platform-provider path.
 *
 * See: docs/superpowers/specs/2026-06-10-wesight-runnode-engine-init-config-design.md
 */

import { CoworkAgentEngine } from '../../shared/cowork/constants';
import type { CoworkApiConfig } from './coworkConfigStore';
import { resolveRawApiConfig } from './claudeSettings';

/**
 * Per-engine default model. Only engines that have a hard-coded "current
 * model" in the local app_config get a default here. The platform-provider
 * resolver uses these defaults when constructing the CoworkApiConfig to
 * write to disk; the engine reads the model from its own file on the next
 * CLI invocation, so these defaults are write-path-only.
 *
 * Engines without a default here (OpenClaw, Hermes, OpenCode, QwenCode,
 * DeepSeekTui) defer to the engine's native default.
 */
const ENGINE_MODEL_DEFAULT: Partial<Record<CoworkAgentEngine, string>> = {
  [CoworkAgentEngine.ClaudeCode]: 'claude-sonnet-4-5',
  [CoworkAgentEngine.Codex]: 'gpt-5.4',
  [CoworkAgentEngine.CodexApp]: 'gpt-5.4',
  // OpenClaw: gateway chooses from `models.providers.<key>.models`
  // Hermes:  YAML `model.default` is the source of truth
  // OpenCode / QwenCode / DeepSeekTui / GrokBuild / YdCowork:
  //   use each engine's existing default in externalAgentConfigSync.ts
};

export type PlatformProviderResolver = (
  engine: CoworkAgentEngine
) => Promise<CoworkApiConfig | null>;

// Module-level setter for the platform-provider resolver. Wired in
// src/main/main.ts initApp() after the B service is constructed.
let resolverImpl: PlatformProviderResolver | null = null;

export function setPlatformProviderResolver(fn: PlatformProviderResolver | null): void {
  resolverImpl = fn;
}

export function getPlatformProviderResolver(): PlatformProviderResolver | null {
  return resolverImpl;
}

export function clearPlatformProviderResolver(): void {
  resolverImpl = null;
}

export interface ResolveApiConfigOptions {
  engine: CoworkAgentEngine;
  /**
   * When true, skip the platform-provider check and go directly to the
   * user's app_config.providers. Use this for LocalCli config source.
   */
  preferUserConfig?: boolean;
  /**
   * When provided, use this as the platform-provider value (sync, no B
   * service call). Hot-path optimization: callers that already have the
   * record can pass it in.
   */
  preFetched?: { baseUrl: string; apiKey: string } | null;
}

/**
 * Resolves the CoworkApiConfig for an engine. Returns null if no source
 * has a value (engine falls back to its native config).
 *
 * Resolution order: preFetched > platform-provider > user app_config > null.
 */
export async function resolveApiConfigForEngine(
  options: ResolveApiConfigOptions
): Promise<CoworkApiConfig | null> {
  // Step 1: preFetched (sync, no B service call)
  if (options.preFetched != null) {
    return buildConfigFromPlatformProvider(options.engine, options.preFetched);
  }

  // Step 2: platform provider (async, via setter)
  if (!options.preferUserConfig && resolverImpl) {
    try {
      const platformConfig = await resolverImpl(options.engine);
      if (platformConfig) {
        return platformConfig;
      }
    } catch (e) {
      console.error('[PlatformProviderResolver] resolver threw, falling back to user config:', e);
    }
  }

  // Step 3: user app_config.providers (existing path, no change)
  try {
    return await resolveRawApiConfig();
  } catch (e) {
    console.error('[PlatformProviderResolver] resolveRawApiConfig threw:', e);
    return null;
  }
}

function buildConfigFromPlatformProvider(
  engine: CoworkAgentEngine,
  platform: { baseUrl: string; apiKey: string }
): CoworkApiConfig {
  return {
    apiKey: platform.apiKey,
    baseURL: platform.baseUrl,
    model: ENGINE_MODEL_DEFAULT[engine] ?? '',
    apiType: 'openai',
  };
}
