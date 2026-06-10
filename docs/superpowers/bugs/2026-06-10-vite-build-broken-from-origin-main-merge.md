# Bug: origin/main merge d9d8d55 silently dropped c3e09f4 changes to `externalAgentConfigSync.ts`

**Discovered:** 2026-06-10 (during B spec Phase 2 work — `vite build` failed when trying to verify B UI changes)
**Severity:** **Critical** — blocks `predist:mac` build chain (first step is `npm run build` = `vite build`)
**Status:** Pre-existing; not introduced by B UI work; introduced by merge `d9d8d55` on 2026-06-10

## Symptoms

```
$ npm run build
src/main/libs/externalAgentProviderStore.ts (20:2): "removeWesightManagedClaudeSettings" is not exported by "src/main/libs/externalAgentConfigSync.ts", imported by "src/main/libs/externalAgentProviderStore.ts".
src/main/libs/externalAgentProviderStore.ts (21:2): "writeJsonObjectWithBackupIfChanged" is not exported by "src/main/libs/externalAgentConfigSync.ts", imported by "src/main/libs/externalAgentProviderStore.ts".
src/main/libs/externalAgentProviderStore.ts (22:2): "writeTextFileWithBackupIfChanged" is not exported by "src/main/libs/externalAgentConfigSync.ts", imported by "src/main/libs/externalAgentProviderStore.ts".
error during build
```

The 6.2 DMG (`release/WeSight-2026.6.2-mac-arm64.dmg`, 427 MB) was built **before** the merge (`e0ad048` pre-c3e09f4) and was not re-verified after `d9d8d55`. The current local main (`866773e` → `5edc984`) cannot build.

## Root Cause

When `d9d8d55` merged `5046b05` (local main with A+B+bundled-runtimes) into `e0ad048` (origin/main, c3e09f4-level), git's auto-merge (or `--ours` strategy) on `src/main/libs/externalAgentConfigSync.ts` silently kept the pre-c3e09f4 file content. The c3e09f4 commit added **983 lines** to this file including:

- `removeWesightManagedClaudeSettings` — strip WeSight-managed keys from a Claude settings dict
- `writeJsonObjectWithBackupIfChanged` — atomic JSON write with backup-and-diff
- `writeTextFileWithBackupIfChanged` — atomic text write with backup-and-diff
- `chooseClaudeCredentialEnvKey` / `applySingleClaudeCredentialEnv` — Claude credential env handling
- `acquireWesightClaudeRuntimeConfig` / `releaseWesightClaudeRuntimeConfig` / `cleanupWesightManagedClaudeSettings` / `createWesightClaudeSettingsBackup` — runtime config lease
- `cleanupWesightManagedCodexConfig` / `applyExternalAgentConfigForEngine` — engine config helpers
- New TOML helpers (`parseTomlStringValue`, `extractTomlTopLevelString`, `removeCodexWesightManagedMetaBlock`, etc.)

These were all added to `externalAgentConfigSync.ts` in c3e09f4. **The merge dropped them.** The companion update to `externalAgentProviderStore.ts` (which imports all of these new functions) **was** merged correctly. So the file is in an inconsistent state.

c3e09f4 also **added new files** that the imports now expect:
- `src/main/libs/deepSeekTuiConfig.ts` (exists locally — OK)
- `src/main/libs/grokBuildConfig.ts` (exists locally — OK)
- Other engine-specific config files

## Why This Wasn't Caught Earlier

- The 6.2 DMG was built on `e0ad048` (pre-c3e09f4). Smoke test only checked runtime resolver + login endpoint + runtime manifest — none of which traverse cowork engine code that hits `externalAgentConfigSync`.
- The merge d9d8d55 was verified by `git log` and `git diff --stat`, but **not** by `npm run build`. We had `c3e09f4-design-analysis.md` flagging that the merge was risky; the design analysis doc said "cherry-pick only 32cee98 + f91ac0e" but the wholesale merge was still done to keep the README + cowork mocks +10 cowork subsystem files in sync.
- The 6.2 DMG's actual runtime behavior in cowork sessions was not tested — only the smoke-test path (RuntimeResolver, login, runtime manifest).

## Fix Options

### Option A: Cherry-pick c3e09f4's `externalAgentConfigSync.ts` file from origin/main
- Smallest change. Adds back the missing 983 lines + their direct call sites.
- Risk: c3e09f4 imports `applyExternalAgentConfigForEngine` (added in c3e09f4) which may not be wired into the cowork engine subsystem in local main.
- Effort: ~1 hour + verification.

### Option B: Apply the c3e09f4 design-pivot cherry-pick (32cee98 + f91ac0e) on top of merge
- We already cherry-picked these from c3e09f4 (commits `6320254` and `be35808`).
- But that cherry-pick doesn't bring back the missing functions. Need to do A on top.

### Option C: Manually reimplement the 3 missing functions inline in `externalAgentConfigSync.ts`
- Add stubs that delegate to existing internal helpers (`writeJsonObject`, `atomicWrite`, etc.) with backup-and-diff logic.
- Smallest semantic change. Doesn't require bringing in all of c3e09f4's cowork pivot.
- Effort: ~30 min — but requires understanding what the original implementations did.

### Option D: Roll back the merge (`d9d8d55` → pre-merge `e0ad048`) and re-do the merge with explicit `--theirs` on this file
- Most thorough. Brings all of c3e09f4 in.
- But c3e09f4 design-pivots from "bundled runtime" to "system-PATH" — bringing all of it in would invalidate our bundled-runtimes work.
- The `c3e09f4-design-analysis.md` doc explicitly recommended NOT doing this.

## Recommended

**Option C** — surgically add the 3 functions to `externalAgentConfigSync.ts` (or a new sibling) and re-export. Don't bring in c3e09f4 wholesale.

Implementation:
1. Read the original implementations from c3e09f4 (`git show c3e09f4:src/main/libs/externalAgentConfigSync.ts`)
2. Add them to a new file `src/main/libs/wesightConfigFile.ts` (smaller surface, easier to reason about)
3. Update `externalAgentProviderStore.ts` imports to point at the new file
4. Verify `npm run build` succeeds
5. Verify the B UI smoke-test (already passing for the renderer) still works

Estimated effort: 1-2 hours including verification.
