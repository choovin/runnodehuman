# c3e09f4 Design Analysis — choovin/runnodehuman vs Wesight B spec

> **Status**: read-only analysis. No merge executed. Created during the
> `C + B` strategy chosen on 2026-06-10 (see git log around `feat/runnode-model-sync`).
>
> **Author**: Mavis (Mavis Team), based on user's request to "拉取最新的代码，评估下合并到本地的风险，还有增加了哪些新特性".

## TL;DR

Upstream's `c3e09f4` (PR #45) is a **major architecture refactor** of the
cowork + external-agent subsystem. It is **NOT** a drop-in replacement for
our B spec (`bundled runtimes`); it is a parallel design that resolves
the same problems through a different lens. The two coexist — neither
cancels the other — but the merge has non-trivial conflicts in 7 files.

**Recommendation**: do **not** merge c3e09f4 now. Cherry-pick the two
low-risk fixes (`32cee98`, `f91ac0e`) that are independent of the larger
refactor. Plan a proper design alignment meeting with choovin before
merging c3e09f4.

---

## Scope of c3e09f4

Single squash commit on `origin/main`:
- **38 files changed, +4604 / -742 lines**
- 12 logical sub-commits (squashed at PR merge)
- Authors: LouisHong (`Activer007@users.noreply.github.com`) + freestylefly (co-author)

### Sub-commit summary (decoded from message)

| Sub-commit | Theme | Risk vs B spec |
|---|---|---|
| `fix(cowork): harden external agent cli integration` | Pull external CLI invocations through WeSight config instead of system PATH | 🟡 High — touches `externalCliRuntimeAdapter` (Task 5) |
| `test(cowork): add external cli smoke and proxy coverage` | New test coverage for external CLI flow | 🟢 Low — additive |
| `chore(release): tighten artifact packaging scripts` | New `run-electron-builder-with-date.cjs`, `wesight-agent-cli-smoke.cjs` | 🟡 Medium — adds new build scripts |
| `fix(cowork): skip WSL paths in CLI detection` | Filter `/mnt/c` etc. in CLI discovery | 🟢 Low |
| `fix(cowork): normalize MiniMax model handling` | Normalize MiniMax provider aliases | 🟢 Low |
| `fix(cowork): route claude code through wesight model` | Force Claude Code subprocess to use WeSight model config | 🔴 High — directly conflicts with Task 4 (claudeSettings resolver) |
| `fix(cowork): enhance session title generation` | New `sessionTitle.ts` (88 lines) — pure helper, no I/O | ⭐ Standalone feature |
| `docs(changelog): record cowork CLI integration updates` | CHANGELOG.md | 🟢 Low |
| `fix(cowork): avoid dynamic hostname regex fallback` | Hardcoded PROXY_BIND_HOST | 🟢 Low |
| `chore(ci): clear session title branch lint warnings` | Lint config tweaks | 🟢 Low |
| `fix(ci): pass renderer type checks` | Renderer type fixes | 🟡 Medium |
| `ci: ensure electron binary before tests` | CI-only | 🟢 Low |
| `test: mock electron in vitest` | New `src/test/mocks/electron.ts` (147 lines) | 🟢 Low |

### New files introduced

| File | Lines | Purpose |
|---|---|---|
| `src/main/libs/coworkOpenAICompatProxy.ts` | 509 | OpenAI ↔ Anthropic protocol conversion; local proxy for cowork |
| `src/main/libs/coworkOpenAICompatProxy.test.ts` | 205 | Tests for the proxy |
| `src/main/libs/coworkRuntimeSnapshot.ts` | 38 | `resolveContinuationRuntimeSnapshot` — figure out which engine a continuing session should use |
| `src/main/libs/coworkRuntimeSnapshot.test.ts` | 51 | Tests |
| `src/main/libs/externalAgentLocalEnv.test.ts` | 160 | Tests for `externalAgentLocalEnv` |
| `src/main/libs/externalAgentConfigSync.test.ts` | 349 | Tests for the rewritten config sync |
| `src/shared/cowork/sessionTitle.ts` | 88 | Pure helpers: `buildSessionTitleContext`, `normalizeSessionTitleToPlainText`, `buildSessionTitlePrompt` |
| `src/shared/cowork/sessionTitle.test.ts` | 66 | Tests |
| `src/test/mocks/electron.ts` | 147 | Vitest mock for `electron` (no need for `vi.mock('electron', () => ...)` in each test) |
| `src/renderer/components/cowork/AgentEnvironmentSetup.tsx` | 6 (tweak) | UI surface tweak |
| `scripts/run-electron-builder-with-date.cjs` | 50 | Build wrapper that injects a date suffix into the artifact filename |
| `scripts/wesight-agent-cli-smoke.cjs` | 382 | Headless smoke test for the agent CLI flow |
| `dev-docs/wesight-agent-cli-programmatic-smoke-test.md` | 198 | Documentation for the smoke test |

### Files heavily modified

| File | + / - | What's new |
|---|---|---|
| `src/main/libs/externalAgentConfigSync.ts` | +814 / many | **Major rewrite**. New `ModelProviderConfig` schema import, `CUSTOM_PROVIDER_KEYS`, provider ↔ agent env mapping. Adds the `externalAgentModelImportResult` shape. |
| `src/main/libs/agentEngine/externalCliRuntimeAdapter.ts` | +386 | Subprocess spawn, env handling, model selection — the heart of cowork. |
| `src/main/libs/coworkUtil.ts` | +158 | Path-prepend, model-override, env-injection helpers. **Direct conflict with our Task 6 (`applyPackagedEnvOverrides`).** |
| `src/main/libs/claudeSettings.ts` | +140 | New credential resolution paths. **Direct conflict with our Task 4 (`getClaudeCodePath` resolver wiring).** |
| `src/main/libs/externalAgentEnvironment.ts` | +154 | Environment snapshot helpers, placeholder defaults. |
| `src/main/libs/externalAgentProviderStore.ts` | +48 | Provider store helpers. |
| `src/main/main.ts` | +125 | Wires the new modules. **Direct conflict with our Task 3 (runtime resolver wiring).** |
| `src/main/im/imCoworkHandler.ts` | +54 | IM ↔ cowork integration. |
| `src/renderer/components/cowork/CoworkEngineSelector.tsx` | +195 | Engine selector UI. |
| `src/renderer/components/Settings.tsx` | +71 | Settings UI tweaks. |
| `src/renderer/services/config.ts` | +76 | Config service updates. |
| `src/shared/providers/constants.ts` | +37 | New provider definitions. |
| `vitest.config.ts` | +3 | Mock electron auto-apply. |

### Files **deleted** by c3e09f4

| File | Note |
|---|---|
| `scripts/setup-bundled-runtimes.cjs` | **CRITICAL** — our B-spec install script. Deleted by upstream in favor of c3e09f4's new architecture. |

Upstream's reasoning (inferred from commit body): the new
`externalAgentLocalEnv` + `coworkOpenAICompatProxy` architecture makes
vendoring runtimes into `vendor/bundled-runtimes/` unnecessary; the
runtime is now expected to be on the host PATH (i.e. user installs
Claude Code / Codex / OpenClaw themselves). This is a **deliberate
product pivot**, not an oversight.

---

## Design tension with B spec (bundled runtimes)

| B spec decision | Upstream c3e09f4 decision | Compatible? |
|---|---|---|
| **Zero-dependency end-user install** (8 runtimes bundled into .app) | User installs CLIs themselves (system PATH) | ❌ **DIRECT OPPOSITE** |
| `vendor/bundled-runtimes/<name>/<ver>/<slice>/` (7 dirs in .app/Resources) | `process.resourcesPath` not used; relies on system PATH | ❌ Conflicts |
| `src/main/runtimeResolver.ts` (89 lines) — single source of truth for runtime paths | `src/main/libs/coworkRuntimeSnapshot.ts` (38 lines) — session-time engine resolution | 🟡 Adjacent — both touch "where is the runtime" question |
| `applyPackagedEnvOverrides` injects bundled node bin to subprocess PATH | `coworkOpenAICompatProxy` uses local proxy + OpenAI/Anthropic protocol transform | 🟡 Different mechanism, same goal (route cowork through WeSight model) |
| B spec keeps WeSight's choice between `we-sight` model and bundled CLI's own model | `route claude code through wesight model` forces it always | ❌ Behavior change |

**The fundamental disagreement**: B spec assumes the user has *no*
CLI tooling installed and ships everything. c3e09f4 assumes the user
*already has* Claude Code / Codex / OpenClaw and WeSight just routes
their output. **Both are valid product stances** but they cannot
coexist on the same install.

This is the design question choovin needs to answer: which product
position is the right one? Cherry-picking `32cee98` /
`f91ac0e` is safe regardless; merging c3e09f4 is not.

---

## What the two low-risk commits add

### `32cee98 fix(cowork): use local Claude Code config fallback` (Jun 10)

4 files, +240/-17. Pure additive:

- New `LocalClaudeConfig.sourceType` discriminator: `'selected_provider' | 'cc_switch' | 'settings'`
- New exported `getClaudeCodeModelFromSettingsConfig(settingsConfig)`:
  scans `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, etc. in
  order; returns first non-placeholder value.
- New exported `getClaudeCodeBaseUrlFromSettingsConfig(settingsConfig)`.
- `externalAgentProviderStore.ts` uses these instead of reading
  `env.ANTHROPIC_MODEL` directly.

**Why it's safe to merge**: it doesn't change the runtime layout
(no file moves, no deletions). It adds a layer of "read the user's
local Claude Code settings first, fall back to ours second". Our B
spec's bundled node is unaffected. **Benefit for our codebase**: when
a user has a working Claude Code install on their machine, our
bundled `claudecode/cli.js` is bypassed in favor of the user's
settings — better UX.

**Conflict risk on our branch**: 🟢 low. Touches
`externalAgentLocalEnv.ts` (we don't modify), `externalAgentProviderStore.ts`
(we don't modify).

### `f91ac0e fix(openclaw): preserve provider api key env aliases` (Jun 8)

1 file, +77/-34. Internal refactor:

- Splits `OpenClawConfigSync.collectSecretEnvVars()` into 3 private
  methods: `collectProviderApiKeyEnvVars`, `collectPersistedApiKeyPlaceholderEnvVars`,
  and the original public method.
- New `API_KEY_ENV_SUFFIX_ALIASES` table:
  ```
  ZHIPU ↔ ZAI
  GEMINI ↔ GOOGLE
  WESIGHT_SERVER ↔ SERVER
  GITHUB_COPILOT ↔ WESIGHT_COPILOT
  ```
- New helpers `setApiKeyEnv`, `readApiKeyEnvAlias` that write/read
  both `WESIGHT_APIKEY_*` and `LOBSTER_APIKEY_*` env vars, plus their
  aliases.
- Removes the `DingTalkInstanceConfig` import from openclawConfigSync
  (cleanup of an unused import).
- Removes the `preinstalledPluginIds` filter in `writeMinimalConfig`
  (cleanup).

**Why it's safe to merge**: it's an internal cleanup + alias table.
The behavior change is: if a user has `WESIGHT_APIKEY_ZAI` set, we now
also expose it as `WESIGHT_APIKEY_ZHIPU` (and vice versa). This
makes the OpenClaw gateway happy regardless of which alias it expects.
**No bundled runtime impact**. **Conflict risk**: 🟢 low on
`openclawConfigSync.ts` — we modified different lines (Task 16 path
migration), so 3-way merge should be clean.

---

## Merge dry-run results (already executed, see commit history)

`git merge-tree` reported 7 files in `UU` (both modified) state:

| File | Our change | Their change | Resolution path |
|---|---|---|---|
| `package.json` | B-spec runtimeManifest, 5 runtime deps | e0ad048 version bump to 2026.6.10; c3e09f4 +16 deps | Keep ours, accept version bump, manual dep union |
| `scripts/nsis-installer.nsh` | Task 15 Defender exclusion | c3e09f4 +44 lines (likely 32cee98 in build script) | Manual diff and union |
| `src/main/libs/agentEngine/externalCliRuntimeAdapter.ts` | Task 5 SpawnCommandSpec.prependPath | c3e09f4 +386 | **High-risk manual merge** |
| `src/main/libs/claudeSettings.test.ts` | Task 4 resolver tests | c3e09f4 +133 | Manual diff |
| `src/main/libs/coworkUtil.ts` | Task 6 applyPackagedEnvOverrides | c3e09f4 +158 | **High-risk manual merge** |
| `src/main/libs/externalAgentConfigSync.ts` | (none) | c3e09f4 +814 | Take theirs |
| `src/main/main.ts` | Task 3 wiring | c3e09f4 +125 | **High-risk manual merge** |

Plus 9 "added by both" files (no conflict, git keeps both):
- `scripts/run-electron-builder-with-date.cjs` (upstream)
- `scripts/wesight-agent-cli-smoke.cjs` (upstream)
- `src/main/libs/coworkOpenAICompatProxy.test.ts` (upstream)
- `src/main/libs/coworkRuntimeSnapshot.test.ts` (upstream)
- `src/main/libs/coworkRuntimeSnapshot.ts` (upstream)
- `dev-docs/wesight-agent-cli-programmatic-smoke-test.md` (upstream)

---

## Recommendation

### Step 1: Cherry-pick the 2 low-risk fixes (this PR)

- `32cee98` — local Claude Code config fallback
- `f91ac0e` — openclaw env aliases

Both are additive, both touch files we don't modify, and both
improve the user experience for users who already have Claude Code /
Codex installed locally. **No design decision needed**.

### Step 2: Talk to choovin about c3e09f4 (out of scope for this PR)

Open a conversation about whether WeSight should be:

a. **Bundled-runtimes product** (B spec): ship a self-contained app
   that works on a clean machine. c3e09f4 is rejected.

b. **System-PATH product** (c3e09f4): assume CLIs are installed, route
   their output. B spec is rejected.

c. **Hybrid**: keep B spec's bundled runtimes as the *default* fallback
   path, but allow opting into the system-PATH path (à la the
   `RuntimeResolver` we already have). Cherry-pick c3e09f4 in pieces
   once the hybrid plan is agreed.

Without this conversation, merging c3e09f4 wholesale will cause
days of conflict resolution and likely force a re-architecture of
B spec.

### What this analysis does NOT cover

- Whether `32cee98` and `f91ac0e` have any *unrelated* changes in
  their diffs (e.g. test cleanup, lint tweaks) that could conflict.
  These are visible in the per-commit `git show` output and should
  be reviewed during the cherry-pick.
- Whether c3e09f4's deletions of pre-existing files (e.g.
  `setup-bundled-runtimes.cjs`) silently remove work we depend on
  in the test suite. The risk is bounded — our `setup-bundled-runtimes.test.cjs`
  imports from the script's `parseManifest` and `vendorDir` exports,
  both of which would be missing post-merge. We'd need to either
  remove that test or re-import the upstream-removed logic.
- The renderer's i18n string changes (Settings.tsx, CoworkEngineSelector.tsx)
  need to be reviewed for the 4 supported locales; this is a
  translation-tracking concern.
