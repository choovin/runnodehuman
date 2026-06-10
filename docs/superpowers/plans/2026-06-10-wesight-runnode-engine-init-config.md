# WeSight × RunNode Engine Init Config Implementation Plan ("C")

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the RunNode platform provider (B spec — baseUrl + apiKey) into the 7 external agent engines (Claude Code, Codex, OpenClaw, Hermes, OpenCode, QwenCode, DeepSeekTui) so a RunNode-logged-in user can use any engine without manually configuring baseUrl/apiKey.

**Spec:** `docs/superpowers/specs/2026-06-10-wesight-runnode-engine-init-config-design.md`

**Tech Stack:** TypeScript, electron, vitest, SQLCipher (existing). No new external deps.

**Worktree:** This is a non-trivial feature touching 8 source files + 1 new module + 1 new service method. **Implement on a feature branch** `feat/runnode-engine-init-config`, not on main. The build-break doc (`docs/superpowers/bugs/2026-06-10-…md`) experience tells us to verify by `npm run electron:dev` + smoke test before merging.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/main/services/cloudPlatformProviderService.ts` | Modify | Add `getCached()` method |
| `src/main/services/cloudPlatformProviderService.test.ts` | Modify | Add `getCached()` tests |
| `src/main/libs/platformProviderResolver.ts` | Create | `resolveApiConfigForEngine()` + per-engine model defaults + `setPlatformProviderResolver()` |
| `src/main/libs/platformProviderResolver.test.ts` | Create | Unit tests for the resolver |
| `src/main/libs/externalAgentConfigSync.ts` | Modify | Pre-check in 3 dispatch points; route to `applyProviderToLive` when platform provider has a value |
| `src/main/libs/openclawConfigSync.ts` | Modify | Same pre-check in `sync()` |
| `src/main/libs/hermesConfigSync.ts` | Modify | Same pre-check in `sync()` |
| `src/main/main.ts` | Modify | Wire `setPlatformProviderResolver` in `initApp`; subscribe to `updated` event |
| `src/main/services/externalAgentProviderStore.ts` | No change | `applyProviderToLive` already works |
| `docs/superpowers/specs/2026-06-10-…md` | Mark Implemented | After all tasks done |

---

## Task 1: Add `getCached()` to `CloudPlatformProviderService`

**Files:**
- Modify: `src/main/services/cloudPlatformProviderService.ts`
- Modify: `src/main/services/cloudPlatformProviderService.test.ts`

**Steps:**

- [ ] **Step 1: Add a private field `cachedRecord: CloudPlatformProviderRecord | null` to the service class**

- [ ] **Step 2: Update the existing `sync()` method to set `this.cachedRecord = record` after a successful load (both the "loaded from store" path and the "freshly synced" path)**

- [ ] **Step 3: Update the existing `setOverride()` method to set `this.cachedRecord` after a successful save**

- [ ] **Step 4: Update the existing `resetDefault()` method to set `this.cachedRecord` after a successful save**

- [ ] **Step 5: Add the public method `getCached(): CloudPlatformProviderRecord | null { return this.cachedRecord; }`**

- [ ] **Step 6: Initialize `this.cachedRecord = null` in the constructor**

- [ ] **Step 7: Add tests for `getCached()`**:
  - After `init()`: `getCached()` returns the loaded record
  - After `setOverride()`: `getCached()` returns the new record with override
  - After `resetDefault()`: `getCached()` returns the record without override
  - Before any sync: `getCached()` returns `null`

**Commit:** `feat(platform-provider): expose getCached() accessor on the service`

---

## Task 2: Create `platformProviderResolver.ts` (the resolver module)

**Files:**
- Create: `src/main/libs/platformProviderResolver.ts`
- Create: `src/main/libs/platformProviderResolver.test.ts`

**Steps:**

- [ ] **Step 1: Define the `ResolveApiConfigOptions` interface** (engine, preferUserConfig, preFetched)

- [ ] **Step 2: Define the per-engine model-defaults table**:

```ts
const ENGINE_MODEL_DEFAULT: Partial<Record<CoworkAgentEngine, string>> = {
  [CoworkAgentEngineValue.ClaudeCode]: 'claude-sonnet-4-5',
  [CoworkAgentEngineValue.Codex]: 'gpt-5.4',
  // OpenClaw, Hermes, OpenCode, QwenCode, DeepSeekTui: undefined (use engine's native default)
};
```

- [ ] **Step 3: Implement `resolveApiConfigForEngine(options)`**:
  1. If `options.preFetched` is provided, build a `CoworkApiConfig` from it (with engine-specific model default, `apiType: 'openai'`)
  2. If `options.preferUserConfig` is true, skip step 4
  3. (Step 4 will be implemented in Task 3 — leave a TODO for now)
  4. (Future) Call the registered resolver to get platform-provider values
  5. Fall through to `resolveRawApiConfig()` (existing function, no change)
  6. Return null if everything is null

- [ ] **Step 4: Implement `setPlatformProviderResolver(fn)` and `getPlatformProviderResolver()`** — module-level setters. The resolver is an `async (engine: CoworkAgentEngine) => CoworkApiConfig | null` function.

- [ ] **Step 5: Implement `clearPlatformProviderResolver()`** — resets to null. Used in tests.

- [ ] **Step 6: Write tests** (TDD, fail first):
  - preFetched-only path: returns config from preFetched
  - preferUserConfig=true: skips platform resolver
  - both null: returns null
  - user config path: mocks `resolveRawApiConfig` to return a value; checks it's returned
  - clearPlatformProviderResolver: subsequent calls return null

- [ ] **Step 7: Add JSDoc to the module** explaining the resolution order, the `setPlatformProviderResolver` setter pattern, and the relationship to B's `effective()` helper

**Commit:** `feat(platform-provider): add resolveApiConfigForEngine resolver`

---

## Task 3: Wire `setPlatformProviderResolver` in `main.ts` (B-service-aware resolver)

**Files:**
- Modify: `src/main/libs/platformProviderResolver.ts` (extend the resolver function from Task 2)
- Modify: `src/main/main.ts` (wire the setter in `initApp`)

**Steps:**

- [ ] **Step 1: In `main.ts initApp`, after `platformProviderService` is constructed**, call:

```ts
setPlatformProviderResolver(async (engine) => {
  const record = platformProviderService.getCached();
  if (!record) return null;
  const eff = effective(record);
  return {
    apiKey: eff.apiKey,
    baseURL: eff.baseUrl,
    model: ENGINE_MODEL_DEFAULT[engine] ?? '',
    apiType: 'openai',
  };
});
```

- [ ] **Step 2: In `platformProviderResolver.ts`, refactor** so the resolver function in `setPlatformProviderResolver` is the one that `resolveApiConfigForEngine` calls. The full resolution order is:
  1. `preFetched` (sync, from options)
  2. `getPlatformProviderResolver()(engine)` (async, from B service)
  3. `resolveRawApiConfig()` (existing path)

- [ ] **Step 3: Verify the wiring compiles** with `npm run compile:electron`

- [ ] **Step 4: Add a test for the integration**: setPlatformProviderResolver returns a value, resolveApiConfigForEngine uses it

**Commit:** `feat(platform-provider): wire B service into resolveApiConfigForEngine`

---

## Task 4: Subscribe to platform-provider `updated` event in main.ts

**Files:**
- Modify: `src/main/main.ts`

**Steps:**

- [ ] **Step 1: Locate where `cloudBroadcaster` is created in `initApp`** (around line 7448). The B service already emits `cloud:platform-provider:updated` via this broadcaster (per the preload exposure in `main/preload.ts:759`).

- [ ] **Step 2: Add a listener** that re-runs the engine-config apply for the current engine:

```ts
cloudBroadcaster.on('cloud:platform-provider:updated', () => {
  try {
    const engine = getCoworkStore().getConfig().coworkAgentEngine;
    void applyExternalAgentConfigSourceForEngine(engine);
  } catch (err) {
    console.error('[PlatformProvider] failed to re-apply engine config on update:', err);
  }
});
```

- [ ] **Step 3: Verify the event channel name matches** between B's broadcaster emit and our listener. Check `src/main/ipcHandlers/cloudAuth.ts` for the `UpdatedEvent` constant.

- [ ] **Step 4: Verify the listener fires on:**
  - User login (A spec's `onLoginSuccess`)
  - User logout (A spec's `onLoggedOut`)
  - 24h background sync (B spec's internal timer)
  - User manual sync from Settings (B spec's IPC `cloud:platform-provider:sync`)

**Commit:** `feat(platform-provider): re-apply engine config on platform-provider updates`

---

## Task 5: Pre-check + route to `applyProviderToLive` in Claude Code dispatch

**Files:**
- Modify: `src/main/libs/externalAgentConfigSync.ts`

**Steps:**

- [ ] **Step 1: Read the current `syncClaudeCodeFromWesightModel` implementation** (line 789). It calls `resolveRawApiConfig()` to get the `CoworkApiConfig` to write.

- [ ] **Step 2: Refactor the entry point** `applyExternalAgentConfigForEngine` (line 874) to pre-check the platform provider before falling back to the per-engine path. Concretely:

```ts
export const applyExternalAgentConfigForEngine = async (
  engine: CoworkAgentEngine,
  source: ExternalAgentConfigSource,
): Promise<void> => {
  if (source !== ExternalAgentConfigSource.WesightModel) {
    // LocalCli path: do not inject platform provider
    applyExternalAgentConfigForEngineLegacy(engine, source);
    return;
  }
  const platformConfig = await resolveApiConfigForEngine({ engine });
  if (platformConfig) {
    // Platform provider has authority — write via applyProviderToLive (backed up)
    await getExternalAgentProviderStore().applyProviderToLive(engine, platformConfig);
  } else {
    // Fall through to legacy path (user's app_config.providers)
    applyExternalAgentConfigForEngineLegacy(engine, source);
  }
};
```

- [ ] **Step 3: Extract the existing implementation** into `applyExternalAgentConfigForEngineLegacy` (private helper). All the existing logic stays there.

- [ ] **Step 4: Make the function async** (it now awaits `resolveApiConfigForEngine` and `applyProviderToLive`)

- [ ] **Step 5: Update all call sites of `applyExternalAgentConfigForEngine`** to `await` the result. Search for non-awaited calls in main.ts. Update them to `void applyExternalAgentConfigForEngine(...)` or `await applyExternalAgentConfigForEngine(...)` depending on context.

- [ ] **Step 6: Verify the existing tests for `applyExternalAgentConfigForEngine` still pass** (with `clearPlatformProviderResolver()` set in `beforeEach`)

- [ ] **Step 7: Add a test for the platform-provider path**:
  - Mock `getPlatformProviderResolver` to return a value
  - Mock `getExternalAgentProviderStore` to spy on `applyProviderToLive`
  - Call `applyExternalAgentConfigForEngine(ClaudeCode, WesightModel)`
  - Assert `applyProviderToLive` was called

**Commit:** `feat(platform-provider): route Claude Code writes through applyProviderToLive when platform provider has a value`

---

## Task 6: Same pre-check for Codex, OpenCode, QwenCode, DeepSeekTui

**Files:**
- Modify: `src/main/libs/externalAgentConfigSync.ts`

**Steps:**

- [ ] **Step 1: Verify the refactor from Task 5 covers all 5 engines dispatched in `applyExternalAgentConfigForEngine`**:
  - ClaudeCode → `syncClaudeCodeFromWesightModel` (via legacy)
  - Codex → `syncCodexFromWesightModel` (via legacy)
  - OpenCode → `applyExternalAgentConfigForEngine(engine, source)` (via legacy)
  - QwenCode → `applyExternalAgentConfigForEngine(engine, source)` (via legacy)
  - DeepSeekTui → `applyExternalAgentConfigForEngine(engine, source)` (via legacy)
  - The new pre-check at the top of `applyExternalAgentConfigForEngine` (now async) handles all 5.

- [ ] **Step 2: QwenCode special case**: the legacy path has OAuth branching at `claudeSettings.ts:555-583`. If the user is on `LocalCli` config source for QwenCode AND the platform provider has a value, the new path **overrides** the OAuth token. Document this in code comment.

- [ ] **Step 3: Verify all 5 engines compile** with `npm run compile:electron`

- [ ] **Step 4: Add per-engine tests** for the platform-provider routing (5 tests, one per engine)

**Commit:** `feat(platform-provider): route Codex/OpenCode/QwenCode/DeepSeekTui writes through applyProviderToLive when platform provider has a value`

---

## Task 7: Same pre-check for OpenClaw and Hermes

**Files:**
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify: `src/main/libs/hermesConfigSync.ts`

**Steps:**

- [ ] **Step 1: Read `OpenClawConfigSync.sync` (line 948)**. It calls `resolveRawApiConfig()` at line 962.

- [ ] **Step 2: Refactor**: add a pre-check at the top of `sync()`. If platform provider has a value AND config source is `WesightModel`, route to `getExternalAgentProviderStore().applyProviderToLive(OpenClaw, platformConfig)`. Else, fall through to the existing implementation.

- [ ] **Step 3: Same for `HermesConfigSync.sync` (line 70)**: pre-check, route to `applyProviderToLive(Hermes, …)`, else fall through.

- [ ] **Step 4: Add per-engine tests** for the platform-provider routing (2 tests)

- [ ] **Step 5: Verify both compile** with `npm run compile:electron`

**Commit:** `feat(platform-provider): route OpenClaw/Hermes writes through applyProviderToLive when platform provider has a value`

---

## Task 8: Update B spec status + write C plan self-review

**Files:**
- Modify: `docs/superpowers/specs/2026-06-10-wesight-runnode-engine-init-config-design.md`

**Steps:**

- [ ] **Step 1: Mark spec as Implemented** with date 2026-06-XX:

```
> **Status:** Implemented (2026-06-XX)
```

- [ ] **Step 2: Update C spec File Map** to reflect what was actually built (vs the planned)

- [ ] **Step 3: Update the Open Questions section** with what was decided

- [ ] **Step 4: Update AGENTS.md** "Build and Development Commands" section to reference the new resolver:

```
- **C — Engine init config**: each engine (Claude Code / Codex / OpenClaw / Hermes / OpenCode / QwenCode / DeepSeekTui) reads the RunNode-platform-provider's baseUrl+apiKey from the B service via `resolveApiConfigForEngine()`. See `docs/superpowers/specs/2026-06-10-wesight-runnode-engine-init-config-design.md`. Code: `src/main/libs/platformProviderResolver.ts`, with the resolver setter wired in `src/main/main.ts initApp`.
```

- [ ] **Step 5: Commit doc updates**

**Commit:** `docs: mark C spec implemented + update AGENTS.md`

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| Single `resolveApiConfigForEngine` resolver | Task 2 + 3 |
| `setPlatformProviderResolver` setter pattern | Task 2 + 3 |
| B service `getCached()` accessor | Task 1 |
| `updated` event re-trigger | Task 4 |
| Claude Code route | Task 5 |
| Codex, OpenCode, QwenCode, DeepSeekTui route | Task 6 |
| OpenClaw, Hermes route | Task 7 |
| Per-engine model defaults | Task 2 (table) |
| Backed-up `applyProviderToLive` path | Task 5, 6, 7 (routing) |
| Out-of-scope (C1 follow-ups) | Documented in spec, not implemented |

**2. Placeholder scan:** No "TBD" / "TODO" / "fill in details" / "similar to Task N".

**3. Type consistency:**
- `resolveApiConfigForEngine` returns `Promise<CoworkApiConfig | null>` — matches what all engine `merge*ForWesightModel` functions take
- `setPlatformProviderResolver` setter type matches the B service's record shape via the `effective()` helper
- `getCached()` returns `CloudPlatformProviderRecord | null` — same as the existing `get()` method

No inconsistencies found. Ready to execute.

---

## Implementation order (recommended)

Execute Tasks 1-7 in order. Task 8 (docs) is last. Each task is a self-contained commit, so review/rollback is easy. Total estimated effort: 6-10 hours.

**Verification gates between tasks:**
- After Task 1: `npm run compile:electron` succeeds
- After Task 3: `npm run compile:electron` + `npm run electron:dev` (dev mode still starts)
- After Task 4: dev mode still starts; check log for `cloud:platform-provider:updated` event
- After Task 5: typecheck + targeted tests for `applyExternalAgentConfigForEngine` (with `clearPlatformProviderResolver()` in `beforeEach`)
- After Task 6: same
- After Task 7: full test suite + dev mode smoke (login, pick engine, verify config file written)
- After Task 8: docs done

**Smoke test at end:**
1. `npm run electron:dev`
2. Log in to RunNode (any account)
3. Pick Claude Code engine in cowork
4. Verify `~/.claude/settings.json` env block contains `ANTHROPIC_BASE_URL` matching the B-synced baseUrl
5. Verify `~/.claude/.wesight-backups/` has a backup
6. Pick Codex engine
7. Verify `~/.codex/config.toml` has the WeSight-managed provider with the synced baseUrl
8. Pick OpenClaw
9. Verify `~/.openclaw/openclaw.json` has the WeSight-managed provider
10. Pick Hermes
11. Verify `~/.hermes/config.yaml` and `~/.hermes/.env` have the WeSight-managed entries
12. Log out of RunNode
13. Verify the last-known values are still in the config files (per Q1 decision: keep last values, no auto-revert)

If all 12 steps pass, C is done. Merge feature branch to main.
