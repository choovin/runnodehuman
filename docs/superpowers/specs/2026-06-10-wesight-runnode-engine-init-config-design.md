# WeSight × RunNode Engine Init Config — Design ("C")

> **Status:** Draft (pre-review) — written 2026-06-10

## Overview

Wire the **RunNode platform provider** (B spec — baseUrl + apiKey) into the **7 external agent engines** (Claude Code, Codex, OpenClaw, Hermes, OpenCode, QwenCode, DeepSeekTui) so that a user logged in to RunNode can use any engine without manually configuring its base URL / API key. The current engines consume `app_config.providers` from the local SQLCipher store; this spec adds a parallel source: `cloudPlatformProviderService.effective()`.

**Scope:**
- Build a `resolveApiConfigForEngine(engine, options)` resolver that prefers the platform provider when present and falls back to the existing `app_config.providers` path
- On engine selection (and on platform-provider updates), the engine's config file is rewritten so the next spawned CLI process picks up the new baseUrl/apiKey
- **Out of scope** (separate specs / future work):
  - Per-engine UX for "sync now" (D or later)
  - Digital employee conversion (D spec)
  - cc-switch integration (C1 follow-up if needed)
  - Backporting `wesightConfigFile.ts` helpers to all 4 legacy write paths (C1 follow-up)

**Success criteria:**
- A user logs in to RunNode via the A-spec login flow
- The B-spec `cloudPlatformProviderService` syncs `new-api/config` (baseUrl + apiKey)
- Picking **any** of the 7 engines in cowork mode uses the RunNode-provided baseUrl/apiKey (not the user's local `app_config.providers`)
- Killing the WeSight process and restarting does not "leak" the platform-provider values into the next user-launched CLI invocation (managed-block marker clean-up)

**Non-goals:**
- The 3rd-party CC-Switch SQLite path stays untouched in this spec (out of scope; see C1 follow-ups)
- We do **not** rewrite the OpenClaw or Hermes temp-dir write paths to use `wesightConfigFile.ts` — that's a separate refactor

## The shape we're targeting

Today: every engine's `merge*ForWesightModel(config)` / `build*EnvForConfig(config)` / `buildProviderSelection(config)` takes a `CoworkApiConfig`:

```ts
type CoworkApiConfig = { apiKey: string; baseURL: string; model: string; apiType?: CoworkApiType };
```

The data source is `app_config.providers` (per-engine override, user-edited). After this spec: the same shape, but the data source can also be the platform provider record. Engine code does **not change** — only the resolver feeding it.

**This is the cheapest possible seam.** All the per-engine merge/format logic already takes `CoworkApiConfig`. We just need to add a function that returns one of those, given an engine and a "current state".

## Approach: One resolver, called from 7 dispatch points

### New module: `src/main/libs/platformProviderResolver.ts`

```ts
import type { CloudPlatformProviderService } from '../services/cloudPlatformProviderService';
import type { CoworkApiConfig } from './coworkConfigStore';
import { CoworkAgentEngine } from '../../shared/cowork/constants';

export interface ResolveApiConfigOptions {
  engine: CoworkAgentEngine;
  /** When true, prefer the user's app_config.providers (legacy path) */
  preferUserConfig?: boolean;
  /** When provided, also accept a pre-fetched platform provider record (avoids async in hot paths) */
  preFetched?: { baseUrl: string; apiKey: string } | null;
}

export async function resolveApiConfigForEngine(
  options: ResolveApiConfigOptions,
): Promise<CoworkApiConfig | null>;
```

**Resolution order** (returns the first non-null):

1. If `options.preFetched` is provided, use it. (Hot-path optimization: callers that already have the record can pass it in.)
2. **Platform provider** — `service.get()` (cached in memory after B's 24h sync) → if non-null, return `{ baseURL: r.baseUrl, apiKey: r.apiKey, model: <sane default per engine>, apiType: 'openai' }`. The model default is per-engine and lives in a tiny table.
3. **User config** — `resolveRawApiConfig(override)` (existing function, no change). Returns the active provider.
4. If both are null, return null (engine falls back to whatever its native config has — e.g., the local CLI's own auth).

**`apiType` is always `'openai'` for platform-provider values** (RunNode's `new-api/config` is OpenAI-compatible per B spec).

### Wiring: 7 dispatch points

| Engine | Dispatch point | Today's source | After C |
|---|---|---|---|
| Claude Code | `externalAgentConfigSync.syncClaudeCodeFromWesightModel` (line 789) | `resolveRawApiConfig()` | `resolveApiConfigForEngine({engine: ClaudeCode})` |
| Codex | `externalAgentConfigSync.syncCodexFromWesightModel` (line 805) | `resolveRawApiConfig()` | same |
| OpenClaw | `openclawConfigSync.sync` (line 948) → `resolveRawApiConfig()` (line 962) | `resolveRawApiConfig()` | same |
| Hermes | `hermesConfigSync.sync` (line 70) → `resolveRawApiConfig()` (line 84) | `resolveRawApiConfig()` | same |
| OpenCode | `applyExternalAgentConfigForEngine(OpenCode, …)` (line ~887) | `resolveRawApiConfig()` | same |
| QwenCode | `applyExternalAgentConfigForEngine(QwenCode, …)` (line ~888) | `resolveRawApiConfig()` (with OAuth branching at lines 555-583) | same (platform provider wins over user OAuth token when both exist) |
| DeepSeekTui | `applyExternalAgentConfigForEngine(DeepSeekTui, …)` (line ~889) | `resolveRawApiConfig()` | same |

**Hook into the platform provider service** via a `setPlatformProviderResolver(fn)` setter on `CloudPlatformProviderService`, OR pass the service as a parameter to `applyExternalAgentConfigForEngine`. The first is cleaner (avoids threading the dependency through 5 layers of helpers). **Decision: setter pattern.**

```ts
// in cloudPlatformProviderService.ts
let getResolver: (() => Promise<CoworkApiConfig | null>) | null = null;
export function setPlatformProviderResolver(fn: typeof getResolver): void { getResolver = fn; }
```

**Triggering re-sync on platform provider updates:** subscribe to the `cloud:platform-provider:updated` IPC event in main process. When it fires, re-run the engine-config apply for the currently-active engine. Concretely:

```ts
// in main.ts
platformProviderService.on('updated', (record) => {
  const engine = getCoworkStore().getConfig().coworkAgentEngine;
  applyExternalAgentConfigSourceForEngine(engine);
});
```

(We already have a `cloudBroadcaster` event emitter for this. The IPC `onUpdate` in preload.ts handles the renderer side; on the main side, we wire the same callback locally.)

### Configuration of the resolver service

Add a small boot hook in `main.ts initApp()`:

```ts
// after platformProviderService is constructed
setPlatformProviderResolver(async () => {
  const r = platformProviderService.getCached();  // sync accessor
  if (!r) return null;
  const eff = effective(r);
  return { apiKey: eff.apiKey, baseURL: eff.baseUrl, model: pickDefaultModelForEngine(engine), apiType: 'openai' };
});
```

**Add `getCached()` to the service** — returns the last in-memory record (set by `sync()`). Avoids hitting SQLCipher on every engine-config rewrite.

**Per-engine model defaults** (a tiny const table in `platformProviderResolver.ts`):

| Engine | Default model |
|---|---|
| Claude Code | `claude-sonnet-4-5` (already the default at `externalAgentConfigSync.ts:108`) |
| Codex | `gpt-5.4` (already the default at line 109) |
| OpenClaw | (no default — let gateway choose; platform provider values land in `models.providers.<key>`) |
| Hermes | (no default — Hermes has its own model list in YAML; platform provider writes a single provider entry) |
| OpenCode, QwenCode, DeepSeekTui | reuse the engine's existing default from `externalAgentConfigSync.ts` constants |

The defaults exist for the **write path** only — the engine reads the model from its own file after we write it, so the next CLI invocation uses whatever we wrote.

### When to apply the resolver

The engine-config write happens at these times today:

1. **App startup** — `applyExternalAgentConfigSourceForEngine` is called from the engine-ready sequence (per `main.ts:1638-1682` `ensureCoworkEngineReady`)
2. **Engine switch** — user picks a different engine in cowork; `applyExternalAgentConfigSourceForEngine` re-runs
3. **Manual "import local config"** — `externalAgentProviderStore.syncOpenClawLiveProviders` etc.
4. **On-demand sync** — `syncOpenClawConfig`, etc., triggered by user action

**After C:**
- All 4 of the above continue to work (the resolver is the new data source — it just returns platform-provider values when available)
- **New trigger**: platform-provider `updated` event → re-apply the current engine's config
- **New trigger**: user logs in (A spec flow) → after B's `sync()` completes, re-apply the current engine's config

**Why the new triggers matter:** the user might be on the cowork screen with Claude Code running. They log out and log in as a different RunNode user (different apiKey). Without the new trigger, the Claude Code process keeps using the old apiKey until restart.

### Restore / cleanup

The current restore story is uneven (per the survey):

- Claude Code: `removeWesightManagedClaudeSettings` exists in `wesightConfigFile.ts` but only restores from the `__wesight_managed.claudeCode.envKeys` marker (legacy branch in our new helper).
- Codex: no restore. Original config.toml is just overwritten.
- OpenClaw: no restore. User has to manually edit.
- Hermes: partial. The `.env` block markers allow removing the WeSight block. YAML `model.*` is not tracked.

**For C, the minimum viable restore story is:**

1. The current `removeWesightManagedClaudeSettings` stays as-is. Its legacy-marker branch (line 205-207) is fine — when WeSight quits without a clean shutdown, it logs a warning and leaves any user-set env keys alone. (The user's local env values are preserved.)
2. Codex's `syncCodexFromLocalCliConfig` is the "switch back to local" path. We don't add a new one.
3. OpenClaw: no change. (User can `osascript 'quit WeSight'` and the local config is whatever we last wrote — which is what they want.)
4. Hermes: the `.env` managed block markers (already present) handle env restore. YAML `model.*` is a write-only side effect; on uninstall, the user can hand-edit. (Documented limitation.)

**Why we don't add a `removeWesightManagedPlatformProviderConfig`:** the platform provider is a **synchronous runtime source** — its values live in the in-memory record + the user's `~/.claude/settings.json` env vars. The same data flows on every CLI invocation. There's no persistent "WeSight wrote this for the platform provider" state that's distinct from "WeSight wrote this for the user config". The managed-marker pattern is more relevant for the *user config* branch (which we leave as-is for C).

**C1 follow-up (NOT in C scope):** standardize restore across all 4 engines. This is real work — adding a uniform `__wesight_managed.<engine>.<shape>` JSON metadata for Codex and OpenClaw, plus YAML metadata for Hermes, plus extending the managed-env-marker for the config.yaml side. Documented in §C1 follow-ups below.

### Backup coverage

The survey revealed backup coverage is uneven:

| Path | Backup? |
|---|---|
| `externalAgentProviderStore.applyProviderToLive` (Claude Code, Codex) | ✓ uses `wesightConfigFile.ts` |
| `externalAgentConfigSync.syncClaudeCodeFromWesightModel` | ✗ no backup |
| `externalAgentConfigSync.syncCodexFromWesightModel` | ✗ no backup |
| `openclawConfigSync.sync` | ✗ no backup |
| `hermesConfigSync.sync` | ✗ no backup |

**For C, the minimum viable backup story is:** when the resolver returns a platform-provider value, the write goes through `externalAgentProviderStore.applyProviderToLive` (which has backup), NOT through `externalAgentConfigSync.syncXxxFromWesightModel` (no backup). This means we **add a new code path** that bypasses the legacy `syncXxxFromWesightModel` for the platform-provider case.

Concretely:

```ts
// in main.ts applyExternalAgentConfigSourceForEngine
if (engine === ClaudeCode) {
  const platformConfig = await resolveApiConfigForEngine({ engine });
  if (platformConfig) {
    // platform provider has authority — write via applyProviderToLive (backed up)
    getExternalAgentProviderStore().applyProviderToLive(...);
  } else {
    // legacy path — use syncClaudeCodeFromWesightModel (unbacked, but unchanged from before C)
    applyExternalAgentConfigForEngine(engine, config.claudeCodeConfigSource);
  }
}
```

This keeps the legacy path's behavior unchanged (good for rollback) and gives the new platform-provider path the full backup treatment.

**C1 follow-up:** backport `wesightConfigFile.ts` helpers to `syncClaudeCodeFromWesightModel`, `syncCodexFromWesightModel`, `openclawConfigSync.sync`, `hermesConfigSync.sync`. Out of scope for C.

### Why this design (over alternatives)

- **Alternative A**: replace `resolveRawApiConfig` everywhere with a new function that returns either the platform provider or the user config. **Why not**: too invasive — the user-config path has OAuth branching (QwenCode) and various env-mutation logic that don't apply to platform-provider values. Mixing them in one function invites bugs.
- **Alternative B**: only inject platform provider at engine-spawn time (env var override), not write to disk. **Why not**: this is what `externalCliRuntimeAdapter.prepareCodexWesightModelHomeForExecMode` already does for Codex. But it doesn't help the other 3 engines, and writing to disk is the only way to make the platform provider's baseUrl show up in the engines' "current model" probes (e.g., the env detection snapshot).
- **Alternative C**: a `ExternalAgentConfigSource.PlatformProvider` enum value. **Why not**: would force a Settings UI change. The current 2-state (WesightModel / LocalCli) per-engine config is already complex; adding a third state across 7 engines is a 2x scope blowup. The current design keeps the existing UI surface and just adds a runtime preference for *which* values to write.
- **Alternative D** (this spec's design): a single new resolver function, called from 7 dispatch points, with a new `updated` event trigger. **Why yes**: minimum diff, leverages the `CoworkApiConfig` shape that every engine already consumes, no Settings UI change, no `ExternalAgentConfigSource` change, and the new path gets backup treatment via `applyProviderToLive`.

## File Map

### New files

| File | Responsibility |
|---|---|
| `src/main/libs/platformProviderResolver.ts` | `resolveApiConfigForEngine()` + per-engine model defaults + `setPlatformProviderResolver()` on the B service |
| `src/main/libs/platformProviderResolver.test.ts` | Unit tests for the resolver: platform-only, user-only, both, neither, override, apiType |
| `src/main/services/cloudPlatformProviderService.ts` (modify) | Add `getCached()` method (returns last in-memory record, set by `sync()`) |
| `src/main/services/cloudPlatformProviderService.test.ts` (modify) | Add `getCached()` tests |

### Modified files

| File | Change |
|---|---|
| `src/main/main.ts` | Wire the resolver setter in `initApp`; add `platformProviderService.on('updated', …)` → `applyExternalAgentConfigSourceForEngine` |
| `src/main/libs/externalAgentConfigSync.ts` | The 3 dispatch points (`syncClaudeCodeFromWesightModel`, `syncCodexFromWesightModel`, `applyExternalAgentConfigForEngine` for OpenCode/QwenCode/DeepSeekTui) get a pre-check: "if platform provider has a value, use `applyProviderToLive` instead" |
| `src/main/libs/openclawConfigSync.ts` | Same: pre-check in `sync()`, route to `applyProviderToLive` if platform provider has a value |
| `src/main/libs/hermesConfigSync.ts` | Same |
| `src/main/services/externalAgentProviderStore.ts` | No API change. `applyProviderToLive` already works — we just route more callers to it. |
| `docs/superpowers/plans/2026-06-10-wesight-runnode-engine-init-config.md` | Implementation plan (Tasks 1-N) |

## Out of scope (C1 follow-ups)

- **Backup backport**: replace `atomicWrite` in 4 legacy paths (`syncClaudeCodeFromWesightModel`, `syncCodexFromWesightModel`, `openclawConfigSync.sync`, `hermesConfigSync.sync`) with `writeTextFileWithBackupIfChanged` from `wesightConfigFile.ts`. The current spec C only goes through the new (backed-up) `applyProviderToLive` path for platform-provider values; the legacy paths stay as-is. Effort: ~2 hours.
- **Restore backport**: add `__wesight_managed.<engine>.<shape>` metadata for Codex (TOML), OpenClaw (JSON), and Hermes YAML. Add `removeWesightManagedPlatformProviderConfig(engine)` to clean up on uninstall. Effort: ~1 day.
- **CC-Switch integration**: the 7th "engine" (per the survey) is the SQLite-backed `cc-switch` providers table. We currently don't route the platform provider through it. Effort: ~1 day.
- **Per-engine UX for "sync now"**: the B spec already has a button in `Settings/CloudPlatformProviderSection`; a "sync now" in the engine selector is a UX nicety. Effort: ~4 hours.
- **Worktree isolation**: this spec is large. Implementation should happen on a feature branch (`feat/runnode-engine-init-config`), not directly on main. The build-break doc (`docs/superpowers/bugs/2026-06-10-…md`) experience tells us to verify by `npm run electron:dev` + smoke test before merging.

## Risk assessment

- **Risk 1 (high)**: `applyProviderToLive` for Claude Code wipes out cc-switch providers. Mitigation: only route to `applyProviderToLive` when the engine's config source is `WesightModel` (not when it's `LocalCli`). The check is `config.claudeCodeConfigSource === 'WesightModel'`.
- **Risk 2 (medium)**: Platform provider record can be `null` briefly (during initial sync). The resolver falls back to user config, then to the engine's native config. No data loss. Mitigation: only call `applyProviderToLive` if `resolveApiConfigForEngine` returns non-null AND the engine's config source is `WesightModel`.
- **Risk 3 (medium)**: The `updated` event trigger can fire during engine execution. Mitigation: debounce — coalesce events within a 1s window. Or just re-apply (the write is idempotent — the merge functions only change content if the new `CoworkApiConfig` differs from the existing).
- **Risk 4 (low)**: The 4 legacy write paths (without backup) will keep running for user-config writes. Mitigation: explicit documentation that the user-config path is unchanged; only the platform-provider path is new.
- **Risk 5 (low)**: The `getCached()` accessor on `CloudPlatformProviderService` could return a stale value. Mitigation: it's only used for "what should we write to disk right now" — if it's stale, the next `sync()` will fix it. Worst case: 1 sync interval of staleness.
- **Risk 6 (low)**: Existing tests for `applyProviderToLive` may not mock the new resolver. Mitigation: the resolver is a settable function; tests can `setPlatformProviderResolver(() => null)` to opt out of the platform-provider path entirely.

## Open questions

- **Q1**: When the user is in `WesightModel` config source and logs out of RunNode, do we (a) keep the last platform-provider values in the engine config files, or (b) immediately revert to the user's local `app_config.providers`? **My recommendation: (a)** — the user can re-log in; values stay the same. Reversion is only on explicit user reset.
- **Q2**: Do we want a new "RunNode" / "Cloud" option in the per-engine config source dropdown? **My recommendation: NO** for C. The platform provider is a **background** value; it's not a primary config source. The user can override via `Settings/CloudPlatformProviderSection`'s "Override baseUrl" / "Override apiKey" inputs. (Same as how `WESIGHT_APIKEY_*` env vars work today — they override, but they don't show up in a dropdown.)
- **Q3**: Should `effective()`'s override-input fields (from B spec's Settings UI) take precedence over the user's `app_config.providers`? **My recommendation: YES** — the override is explicit user intent. Resolution order: override > platform provider > user config.
