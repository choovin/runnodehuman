# Bug: origin/main merge d9d8d55 silently dropped c3e09f4 changes to `externalAgentConfigSync.ts`

**Discovered:** 2026-06-10 (during B spec Phase 2 work — `vite build` failed when trying to verify B UI changes)
**Severity:** **Critical** — blocks `predist:mac` build chain AND `npm run electron:dev` (compile:electron = `tsc` exits non-zero on the same errors)
**Status:** Pre-existing; not introduced by B UI work; introduced by merge `d9d8d55` on 2026-06-10

## Symptoms

```
$ npm install
up to date in 3s    # silently installed WRONG packages (package.json was reverted by merge)

$ npm run electron:dev
> wesight@2026.6.10 compile:electron
> tsc --project electron-tsconfig.json

src/main/coworkEventStore.ts(1,22): error TS2307: Cannot find module 'better-sqlite3-multiple-ciphers'
src/main/libs/externalAgentProviderStore.ts(20,3): error TS2305: Module '"./externalAgentConfigSync"' has no exported member 'removeWesightManagedClaudeSettings'
src/main/libs/externalAgentProviderStore.ts(21,3): error TS2305: Module '"./externalAgentConfigSync"' has no exported member 'writeJsonObjectWithBackupIfChanged'
src/main/libs/externalAgentProviderStore.ts(22,3): error TS2305: Module '"./externalAgentConfigSync"' has no exported member 'writeTextFileWithBackupIfChanged'
src/main/utils/sqlcipherKey.ts(3,31): error TS2307: Cannot find module 'node-machine-id'
... 25 errors total
```

The 6.2 DMG (`release/WeSight-2026.6.2-mac-arm64.dmg`, 427 MB) was built **before** the merge (`e0ad048` pre-c3e09f4) and was not re-verified after `d9d8d55`. The current local main (`866773e` → `5edc984`) cannot build or run.

## Root Cause

When `d9d8d55` merged `5046b05` (local main with A+B+bundled-runtimes) into `e0ad048` (origin/main, c3e09f4-level), git's merge resolution silently dropped content on **TWO** files:

### File 1: `src/main/libs/externalAgentConfigSync.ts`
Git auto-merge (or `--ours`) kept the pre-c3e09f4 file content. c3e09f4 added **983 lines** to this file including:

- `removeWesightManagedClaudeSettings` — strip WeSight-managed keys from a Claude settings dict
- `writeJsonObjectWithBackupIfChanged` — atomic JSON write with backup-and-diff
- `writeTextFileWithBackupIfChanged` — atomic text write with backup-and-diff
- `chooseClaudeCredentialEnvKey` / `applySingleClaudeCredentialEnv` — Claude credential env handling
- `acquireWesightClaudeRuntimeConfig` / `releaseWesightClaudeRuntimeConfig` / `cleanupWesightManagedClaudeSettings` / `createWesightClaudeSettingsBackup` — runtime config lease
- `cleanupWesightManagedCodexConfig` / `applyExternalAgentConfigForEngine` — engine config helpers
- New TOML helpers (`parseTomlStringValue`, `extractTomlTopLevelString`, `removeCodexWesightManagedMetaBlock`, etc.)

These were all added to `externalAgentConfigSync.ts` in c3e09f4. **The merge dropped them.** The companion update to `externalAgentProviderStore.ts` (which imports all of these new functions) **was** merged correctly. So the file is in an inconsistent state.

### File 2: `package.json`
The merge took `--theirs` (e0ad048 side, pre-`fafdf77` SQLCipher rename). This **reverted two changes** that `fafdf77` made on 2026-06-05:

- `pretest` script: `npm rebuild better-sqlite3` (reverted from `npm rebuild better-sqlite3-multiple-ciphers`)
- `dependencies.better-sqlite3`: `^12.8.0` (reverted from `better-sqlite3-multiple-ciphers: ^12.8.0`)
- `dependencies.node-machine-id`: missing (reverted from being added)

Result: `npm install` succeeds but installs the **wrong packages**. The code (and the c3e09f4-merged `externalAgentConfigSync.ts` line 1) imports `better-sqlite3-multiple-ciphers` and `node-machine-id` — but they don't exist in `node_modules/`. 22 source files fail to typecheck with `TS2307: Cannot find module 'better-sqlite3-multiple-ciphers'`.

**This is a critical SQLCipher stack break**: `cloudAuthTokenStore`, `cloudPlatformProviderStore`, `cloudUserDeviceStore`, `coworkEventStore`, `coworkStore`, `mcpStore`, `migrate.ts`, `sqliteStore.ts`, and ~15 other files all import the missing module. The whole app depends on it for token / device / cowork-event storage.

c3e09f4 also **added new files** that the imports now expect:
- `src/main/libs/deepSeekTuiConfig.ts` (exists locally — OK)
- `src/main/libs/grokBuildConfig.ts` (exists locally — OK)
- Other engine-specific config files

## Why This Wasn't Caught Earlier

- The 6.2 DMG was built on `e0ad048` (pre-c3e09f4). Smoke test only checked runtime resolver + login endpoint + runtime manifest — none of which traverse cowork engine code that hits `externalAgentConfigSync`.
- The merge d9d8d55 was verified by `git log` and `git diff --stat`, but **not** by `npm install` or `npm run build`. We had `c3e09f4-design-analysis.md` flagging that the merge was risky; the design analysis doc said "cherry-pick only 32cee98 + f91ac0e" but the wholesale merge was still done to keep the README + cowork mocks +10 cowork subsystem files in sync.
- The 6.2 DMG's actual runtime behavior in cowork sessions was not tested — only the smoke-test path (RuntimeResolver, login, runtime manifest).
- `npx tsc --noEmit` (run after the merge in this session) had the same errors but was assumed to be "pre-existing native module issue" — not investigated as a regression.

## Fix Options

### Option A: Cherry-pick c3e09f4's `externalAgentConfigSync.ts` file from origin/main
- Smallest change for file 1. Adds back the missing 983 lines + their direct call sites.
- Does NOT fix file 2 (package.json revert) — that's a separate fix.
- Risk: c3e09f4 imports `applyExternalAgentConfigForEngine` (added in c3e09f4) which may not be wired into the cowork engine subsystem in local main.
- Effort: ~1 hour + verification.

### Option B: Apply the c3e09f4 design-pivot cherry-pick (32cee98 + f91ac0e) on top of merge
- We already cherry-picked these from c3e09f4 (commits `6320254` and `be35808`).
- But that cherry-pick doesn't bring back the missing functions. Need to do A on top.
- Does NOT fix file 2 either.

### Option C: Manually reimplement the 3 missing functions inline in `externalAgentConfigSync.ts`
- Add stubs that delegate to existing internal helpers (`writeJsonObject`, `atomicWrite`, etc.) with backup-and-diff logic.
- Smallest semantic change. Doesn't require bringing in all of c3e09f4's cowork pivot.
- Effort: ~30 min — but requires understanding what the original implementations did.
- Does NOT fix file 2 either.

### Option D: Roll back the merge (`d9d8d55` → pre-merge `e0ad048`) and re-do the merge with explicit `--theirs` on this file
- Most thorough. Brings all of c3e09f4 in.
- But c3e09f4 design-pivots from "bundled runtime" to "system-PATH" — bringing all of it in would invalidate our bundled-runtimes work.
- The `c3e09f4-design-analysis.md` doc explicitly recommended NOT doing this.

## Recommended

**Option C for file 1 + manual package.json re-fix for file 2.** Don't bring in c3e09f4 wholesale.

Implementation:
1. **File 1 fix**: read the original implementations from c3e09f4 (`git show c3e09f4:src/main/libs/externalAgentConfigSync.ts`), add the 3 missing functions to a new file `src/main/libs/wesightConfigFile.ts`, update `externalAgentProviderStore.ts` imports.
2. **File 2 fix**: manually edit `package.json` to:
   - Revert `pretest` to `npm rebuild better-sqlite3-multiple-ciphers`
   - Change `dependencies.better-sqlite3` → `dependencies.better-sqlite3-multiple-ciphers: ^12.8.0`
   - Add `dependencies.node-machine-id`
3. `rm -rf node_modules package-lock.json && npm install`
4. Verify `npm run compile:electron` (tsc) succeeds
5. Verify `npm run electron:dev` starts vite dev server + electron app
6. Verify the B UI smoke-test (already passing for the renderer) still works

Estimated effort: 1-2 hours including verification.

**Note**: The SQLCipher-rename story in `fafdf77` has a side-effect: `better-sqlite3-multiple-ciphers` is a **fork** of `better-sqlite3` with SQLCipher compiled in (the standard `better-sqlite3` is plain SQLite3, no encryption). The merge reverting this means **the entire app loses SQLCipher encryption for cloud tokens, device records, cowork events, etc.** This is not just a build issue — it's a **security regression** in the merged main that the user (and any customer storing RunNode tokens) needs to know about.
