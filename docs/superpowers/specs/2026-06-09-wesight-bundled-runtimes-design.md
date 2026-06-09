# WeSight Bundled Runtimes — Design Spec

**Status:** Draft (pre-review)
**Date:** 2026-06-09
**Author:** brainstorming session
**Scope:** WeSight × RunNode integration; electron-builder packaging

## Background

WeSight today ships as a single Electron bundle plus the OpenClaw gateway runtime
that is pre-built per platform into `vendor/openclaw-runtime/current/`. Every
other runtime the application spawns (Node.js, Python, git, gh CLI, Claude Code,
Codex, Hermes Agent) is either assumed to be present on the host's `PATH` or
fetched on first use via `npm install -g` / `curl | bash`.

This forces every end user to install Node 24, Python 3, git, gh, and at least
one AI agent CLI before WeSight is usable. For an end-user-facing product that
promises a turnkey "download, install, log in" experience, this is a deal-breaker.

The existing `OpenClaw` runtime is already bundled; this spec extends the same
mechanism to the remaining runtimes so the installer carries everything the app
needs to function.

## Goals

- End user downloads a single WeSight installer and is immediately able to log in
  and run a cowork session without installing any host-level dependencies.
- The installer carries 8 bundled runtimes: Node.js, Python, git, gh, Claude
  Code, Codex, OpenClaw, and Hermes Agent. Each runtime is pinned to a specific
  version via a manifest with an upstream SHA-256.
- The chosen path is the **all-bundled, zero-network** model. No first-run
  download. No "click to install Claude Code" wizard. The install is the install.

## Non-Goals

- Stripping / pruning runtime contents to reduce package size. Weights of
  1.5-2.5 GB per platform are accepted as the cost of a true zero-dependency
  install.
- Replacing the `npm install -g` / `curl | bash` install paths that exist for
  developer builds. Those paths remain intact for `npm run electron:dev` and
  CI-debug use. The resolver simply prefers the bundled path when present.
- Auto-upgrading bundled runtimes between WeSight releases. Runtimes move
  forward only when a new WeSight release ships.
- Bundling the OpenClaw plugins in a new location. They keep their existing
  layout under `vendor/openclaw-runtime/<target>/` and are migrated into the
  unified `vendor/bundled-runtimes/` namespace without restructuring.

## Design

### 1. Architecture

The 8 runtimes are pre-built per platform into `vendor/bundled-runtimes/`,
copied into the app bundle's `Resources/wesight-runtime/` directory by an
extended `beforePack` hook, and resolved at runtime through a new
`RuntimeResolver` module that is the only path the application uses to find
these binaries.

```
┌────────────────────────────────────────────────────────────────────┐
│  CI Build Matrix (mac-arm64 / mac-x64 / win-x64 / linux-x64 /     │
│  linux-arm64)                                                      │
│                                                                    │
│  Step 1: setup-bundled-runtimes.cjs                                │
│    ↓ Pulls 8 runtimes from upstream sources to                     │
│      vendor/bundled-runtimes/<name>/<ver>/<platform>/<arch>/       │
│    ↓ Verifies SHA-256 against a pinned manifest                    │
│  Step 2: electron-builder                                           │
│    ↓ beforePack hook: verify all 8 binaries present +              │
│      cp to appOutDir/.../resources/wesight-runtime/                │
│  Step 3: mac: notarize.js with --deep re-sign of all binaries     │
│  Step 4: Output release/WeSight-<ver>-<platform>-<arch>.<ext>      │
└────────────────────────────────────────────────────────────────────┘
                              ↓ user installs
┌────────────────────────────────────────────────────────────────────┐
│  WeSight.app/Contents/Resources/wesight-runtime/                   │
│    node/22.11.0/darwin-arm64/{bin/node, ...}                       │
│    python/3.12.7/darwin-arm64/...                                   │
│    git/2.47.1/darwin-arm64/{bin/git, libexec/...}                  │
│    gh/2.65.0/darwin-arm64/{bin/gh, ...}                            │
│    claudecode/<npm-tag>/darwin-arm64/{bin/claude, node_modules/}  │
│    codex/<npm-tag>/darwin-arm64/{bin/codex, node_modules/}        │
│    hermes/<release-tag>/darwin-arm64/{bin/hermes, ...}            │
│    openclaw/<ver>/darwin-arm64/{openclaw.mjs, node_modules/,      │
│                   extensions/, gateway-bundle.mjs}                 │
└────────────────────────────────────────────────────────────────────┘
                              ↓ main process starts
┌────────────────────────────────────────────────────────────────────┐
│  src/main/runtimeResolver.ts                                       │
│    new RuntimeResolver(process.resourcesPath)                      │
│    .tryGetAll() → Map<RuntimeName, ResolvedRuntime | null>         │
│    .tryGetPath(name) → string | null                               │
│    .buildPath(name) → 'bin:libexec:share:...' PATH fragment        │
└────────────────────────────────────────────────────────────────────┘
```

**Architectural invariants:**

1. `RuntimeResolver` is the only supported way to look up these binary paths.
   Direct `path.join(process.resourcesPath, ...)` calls and direct references
   to `vendor/bundled-runtimes/...` are linted as errors.
2. The 8 runtimes follow the same model as the existing `OpenClaw` runtime.
   Each runtime is pre-built per platform into
   `vendor/bundled-runtimes/<name>/<ver>/<target>/` and synced to a
   `current/` directory (matching the existing `vendor/openclaw-runtime/
   current/` pattern). `OpenClaw` migrates into the new namespace; the
   `current/` directory is the canonical read path for the resolver and the
   `beforePack` hook. OpenClaw's internal layout (gateway-bundle.mjs,
   `extensions/`, `node_modules/`) is preserved verbatim.
3. `RuntimeResolver.tryGet*` methods never throw. Missing runtimes return
   `null`. The resolver's role is reporting; the caller's role is choosing a
   fallback.
4. The `externalAgentCliInstaller` install paths (`npm install -g`,
   `curl | bash`) remain fully functional. They are now consulted only when
   the resolver returns `null`, which happens in developer builds and never in
   production installs.
5. **MCP server child processes are user-controlled.** The resolver's
   `buildPath` is NOT injected into `mcpServerManager`-spawned processes
   when the MCP server config specifies a different `command` (e.g.,
   `python3.11`). User-configured MCP servers take precedence; the resolver
   only supplies a default when the config omits an explicit command.
6. **SKILLs (e.g. `SKILLs/web-search`) ship their own `node_modules`.** SKILL
   subprocesses run with their own bundled `node_modules` and are NOT
   affected by the resolver's PATH override. The resolver only applies to
   the 8 bundled runtimes.
7. **In dev mode or when the user has a same-kind runtime installed at
   higher version than the bundled one, the user's installation wins.**
   The resolver does NOT override an already-working host tool. (Tuning per
   runtime is deferred to a follow-up.)

### 2. Components

#### 2.1 New components

| Path | Responsibility |
| --- | --- |
| `scripts/setup-bundled-runtimes.cjs` | Pulls 8 runtimes from upstream; writes `vendor/bundled-runtimes/manifest.json`; verifies SHA-256. Fetches on a per-platform basis so the matrix stays narrow. |
| `src/main/runtimeResolver.ts` | Runtime path resolution. Public API: `new RuntimeResolver(resourcesPath)`, `tryGetAll()`, `tryGetPath(name)`, `buildPath(name)`, `getHealth()`. Never throws. |
| `src/shared/runtime/constants.ts` | `RuntimeName` string-literal union plus the 8 `RuntimeName.X` constants. Mirror of the existing `IpcChannel` pattern. |
| `src/shared/runtime/manifest.ts` | Type definitions for `RuntimeManifest` (per-runtime version + SHA-256 + upstream URL). Read by both the CI script and the resolver at startup for log purposes. |
| `src/main/runtimeResolver.test.ts` | Vitest unit tests covering path resolution, missing-binary behavior, and `buildPath` output for all 8 runtimes. |
| `scripts/setup-bundled-runtimes.test.cjs` | Node test runner tests mocking upstream fetches; covers SHA-256 mismatch, partial fetch, manifest write. |
| `src/main/ipcHandlers/runtime.ts` | IPC bridge exposing `window.electron.runtime.getHealth()` to the renderer for the diagnostics page. |

#### 2.2 Modified components

| Path | Change |
| --- | --- |
| `package.json` | Add `runtimeManifest` field with 8 version blocks; add `setup-bundled-runtimes` script; chain it into `predist:*` scripts. |
| `scripts/electron-builder-hooks.cjs` | Extend `beforePack(context)` to verify all 8 binaries are present for the target and `cp` them into `appOutDir/.../resources/wesight-runtime/`. Preserve existing `ensureBundledOpenClawRuntime` behaviour; OpenClaw is now sourced from `vendor/bundled-runtimes/openclaw/<ver>/<target>/` rather than the old `vendor/openclaw-runtime/<target>/`. |
| `electron-builder.json` | Add `extraResources` entries for `wesight-runtime/` on mac, win, and linux. Each platform gets only its own slice. Keep existing `SKILLs` and `tray` entries. |
| `scripts/notarize.js` | Add `codesign --force --deep --sign "Developer ID Application: <id>"` step before notarization so the 8 newly-embedded binaries inherit the app's signature and entitlements. |
| `src/main/main.ts` | After `initApp()` boot, instantiate the resolver, call `tryGetAll()`, log a `console.warn` for any missing runtime, and expose the result to the renderer via `window.electron.runtime`. |
| `src/main/libs/claudeSettings.ts` | `getClaudeCodePath()` prefers `runtimeResolver.tryGetPath('claudecode')`. Fall back to the existing `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` path if the resolver returns `null` (developer builds). |
| `src/main/libs/agentEngine/externalCliRuntimeAdapter.ts` | When spawning `claude` / `codex` / `qwen` / `opencode` / `grok` / `deepseek-tui`, the `command` is `runtimeResolver.tryGetPath(<name>)` with the same dev-mode fallback as above. The spawn `env` always prepends `runtimeResolver.buildPath(<name>)` to `PATH` so child processes can find bundled `node`. |
| `src/main/libs/coworkUtil.ts` | After `buildEnvForConfig`, prepend the resolver's `buildPath('claudecode')` to `env.PATH` so subprocesses inherit it. The final PATH order is: `[bundled-runtime-bin-paths (resolver output), electron-node-shim (existing), system32 (win), git-bash (win), python-win (existing), registry PATH (win, existing), user shell PATH]`. The resolver's `buildPath('claudecode')` MUST include the bundled `node` binary's `bin/` directory so the `claude` shebang `#!/usr/bin/env node` resolves to the bundled node, not the host's. |
| `src/main/libs/externalAgentCliInstaller.ts` | At each `install<Runtime>` entry point, check the resolver first. If it returns a path, short-circuit with `{ success: true, installMethod: 'bundled', binaryPath: <resolver path> }` and skip the `npm install -g` / `curl | bash` path. Keep the existing install paths intact for the resolver-miss case. |
| `eslint.config.js` | Add `no-restricted-syntax` rules that fail the lint when `process.resourcesPath` is concatenated with a runtime name in source, or when `vendor/bundled-runtimes` appears under `src/`. |
| `vite.config.ts` | Add `import.meta.env.WESIGHT_BUNDLED_RUNTIMES_AVAILABLE = true` to the `define` block so the renderer can detect the bundled path without reading actual paths. |
| `AGENTS.md` | Add a "Bundled Runtimes" section listing the 8 runtimes, their pinned versions, and the upgrade procedure. Add `setup-bundled-runtimes` to the build commands table. |
| `scripts/openclaw-runtime-host.cjs` | Update to source from `vendor/bundled-runtimes/openclaw/<ver>/<target>/` rather than `vendor/openclaw-runtime/<target>/`. Keep all the existing plugin + gateway-bundle validation logic. |
| `scripts/sync-openclaw-runtime-current.cjs` | Update to read from `vendor/bundled-runtimes/openclaw/<ver>/<target>/` and write the `current/` copy under the same parent. |
| `scripts/bundle-openclaw-gateway.cjs` | Update the gateway-bundle output path to live under `vendor/bundled-runtimes/openclaw/<ver>/<target>/gateway-bundle.mjs` instead of `vendor/openclaw-runtime/<target>/`. |
| `scripts/ensure-openclaw-plugins.cjs`, `scripts/ensure-openclaw-version.cjs`, `scripts/precompile-openclaw-extensions.cjs`, `scripts/prune-openclaw-runtime.cjs`, `scripts/pack-openclaw-tar.cjs` | Update path roots from `vendor/openclaw-runtime` to `vendor/bundled-runtimes/openclaw/<ver>/`. |
| `package.json` scripts `openclaw:runtime:mac-arm64`, `openclaw:runtime:mac-x64`, `openclaw:runtime:win-x64`, `openclaw:runtime:win-arm64`, `openclaw:runtime:linux-x64`, `openclaw:runtime:linux-arm64` | Update the per-target helper scripts (`scripts/run-build-openclaw-runtime.cjs`, `scripts/sync-openclaw-runtime-current.cjs`) to write into `vendor/bundled-runtimes/openclaw/<ver>/<target>/`. The 6 npm scripts themselves keep their names; only the script contents change. |
| `src/main/libs/openclawConfigSync.ts` (line 313-314) | Update the dev-mode fallback paths from `vendor/openclaw-runtime/current` to `vendor/bundled-runtimes/openclaw/<ver>/current`. The packaged-build path (`process.resourcesPath/cfmind`) is unchanged. |
| `src/main/libs/openclawLocalExtensions.ts` (line 34-35) | Same as above: dev-mode fallback paths only. Packaged-build path (`process.resourcesPath/cfmind/extensions`) is unchanged. |
| `src/main/libs/externalAgentCliInstaller.ts` (`openclaw` install target) | The `openclaw` install method's `npm install -g openclaw` path is preserved verbatim for dev mode. The resolver fast path is the same shape as for `claudecode` / `codex` / `hermes`; when `runtimeResolver.tryGetPath('openclaw')` returns a path, the method short-circuits with `installMethod: 'bundled'`. |

#### 2.3 Components that are NOT changed

- `src/main/libs/externalAgentCliInstaller.ts`: the install scripts, the
  install-method enum, and the IPC entry points are preserved verbatim.
  Only the head of each install method is short-circuited by a resolver
  check.
- `src/main/services/cloudPlatformProviderService.ts`: does not spawn
  binaries, only performs HTTPS calls. No change.
- `src/main/services/cloudAuth.ts`: same — HTTPS only.
- Existing engine adapters (`yd_cowork`, `openclaw`, `hermes`): internal
  logic is unchanged. The resolver sits in front of them, not inside them.
- Mac code signing identity, Windows Defender exclusion opt-in, NSIS
  installer script: unchanged.

### 3. Data Flow

#### 3.1 CI build (push → release artifact)

```
1. developer: git push
2. GH Actions matrix (5 platforms)
3. checkout, npm ci
4. npm run setup-bundled-runtimes
     Input:  package.json:runtimeManifest (8 version blocks)
     Output: vendor/bundled-runtimes/
       ├── manifest.json                (versions, sha256, upstream URLs)
       ├── node/22.11.0/{darwin-arm64, darwin-x64, win-x64, linux-x64, linux-arm64}
       ├── python/3.12.7/<each platform>
       ├── git/2.47.1/<each platform>
       ├── gh/2.65.0/<each platform>
       ├── claudecode/<npm-tag>/<each platform>
       ├── codex/<npm-tag>/<each platform>
       ├── hermes/<release-tag>/<each platform>
       └── openclaw/<ver>/<each platform>
     Failure: any fetch error or sha256 mismatch throws and exits 1
5. npm run build + compile:electron + build:skills
6. electron-builder --mac/--win/--linux
     beforePack hook:
       - resolve current target (mac-arm64, win-x64, ...)
       - for each of 8 runtimes: check key binary exists for target
       - on any miss: throw with explicit message
       - on success: cp -r vendor/bundled-runtimes/<target>/*  →
         appOutDir/.../resources/wesight-runtime/
7. mac: scripts/notarize.js with --deep codesign of the whole bundle
8. Output: release/WeSight-<ver>-<platform>-<arch>.<ext>
```

Per-platform disk footprint of the produced artifacts (no stripping, no
pruning):

- mac-arm64 universal: ~1.5-1.8 GB
- win-x64: ~1.2-1.3 GB
- linux-x64: ~1.0-1.1 GB
- linux-arm64: ~1.0-1.1 GB

#### 3.2 User install (artifact on disk)

The `extraResources` directory ends up at a well-known location on every
platform because electron-builder unpacks it next to the main executable:

- macOS: `/Applications/WeSight.app/Contents/Resources/wesight-runtime/`
- Windows: `C:\Program Files\WeSight\resources\wesight-runtime\`
- Linux: inside the AppImage mount, `<mount>/resources/wesight-runtime/`

The main process reads this via the standard `process.resourcesPath` constant
that Electron exposes, so the resolver does not need to know platform-specific
paths.

#### 3.3 App startup (double-click to first paint)

```
WeSight launches → main.ts initApp
  ↓
new RuntimeResolver(process.resourcesPath)
  ↓
tryGetAll() returns:
  {
    node:    { path, version, source: 'bundled' } or null,
    python:  ...,
    git:     ...,
    gh:      ...,
    claudecode: ...,
    codex:   ...,
    hermes:  ...,
    openclaw:...,
  }
  ↓
If any runtime is null: console.warn + render warning in Settings
  panel. App continues to start.
  ↓
Continue normal initApp().
```

Startup is never blocked by a missing runtime. The resolver's job is to
report, the caller's job is to choose a fallback.

#### 3.4 Runtime call (user picks Claude Code engine)

```
1. user clicks "Test" on the Claude Code engine in Settings
2. externalAgentCliInstaller.installClaudeCode()
     a. runtimeResolver.tryGetPath('claudecode') returns the bundled path
     b. returns { success: true, installMethod: 'bundled', binaryPath }
     c. skips the npm install -g path entirely
3. user starts a cowork session with agentEngine=claude_code
4. externalCliRuntimeAdapter starts the session
     a. command = runtimeResolver.tryGetPath('claudecode')
     b. env.PATH = runtimeResolver.buildPath('claudecode') + ':' + process.env.PATH
     c. spawn(command, args, { env })
5. claude process starts. It internally spawns `node` to load the SDK.
   The `node` it finds is the bundled one because PATH was prepended.
6. SDK loads, connects to the configured Anthropic-compatible endpoint,
   streams the cowork session back to the renderer.
```

#### 3.5 Upgrade (new WeSight release)

The next WeSight installer replaces the app bundle. `Resources/wesight-runtime/`
is fully replaced with the new version. No migration is required because
runtimes do not persist state into the user's data directory. The next
launch picks up the new resolver paths automatically.

### 3.6 MCP server subprocesses (NOT affected by resolver)

`mcpServerManager` spawns user-configured MCP servers. Each server's
config specifies its own `command` (e.g. `python3.11`, `node`, an absolute
path). The resolver's PATH override is **not** injected into these
subprocesses. If the config omits a command, the resolver supplies a
default (`node` for JS-based servers, `python3` for Python-based ones).
User-specified commands always win.

### 3.7 SKILL subprocesses (NOT affected by resolver)

`SKILLs/web-search/`, `SKILLs/imap-smtp-email/`, and other SKILLs ship
their own `node_modules` (or Python `site-packages`). SKILLs are spawned
with their own `cwd` and unmodified `PATH` so the SKILL's own
`require()` / `import` resolution and child process lookups continue to
work. The resolver only applies to the 8 bundled runtimes, not to
SKILL-spawned subprocesses.

### 4. Error Handling

#### 4.1 CI fetch failures

All 8 runtime fetches are fail-fast. The CI job exits 1 with a specific error
message naming the failing runtime, its upstream URL, and the HTTP code. No
release is produced. This is by design: a half-bundled release is worse than
no release.

| Runtime | Upstream | Failure modes handled |
| --- | --- | --- |
| node | nodejs.org tar.xz (linux) / pkg (mac) / msi (win) | network, 404, sha256 mismatch |
| python | python.org `.pkg` (mac) / embeddable zip (win) / tarball (linux) | same |
| git | git-scm.com portable tar (mac) / portable .zip (win) / linux tar | same |
| gh | github.com/cli/cli releases | GitHub API rate limit, 5xx |
| claudecode | npm registry `@anthropic-ai/claude-code` | npm 5xx, version not found |
| codex | npm registry `@openai/codex` | same |
| hermes | github.com/NousResearch/hermes-agent releases | GitHub 5xx, asset not found |
| openclaw | existing `openclaw:runtime:<target>` flow | unchanged |

#### 4.2 beforePack hook failures

The hook verifies each of the 8 binaries is present before copying. Any
missing binary throws a descriptive error and aborts the build:

- `Runtime <name> missing for target <target>. Expected: <binary path>`
- `Copy failed: <src> -> <dst>: <errno message>`

#### 4.3 Runtime missing on user machine

If the resolver returns `null` for a runtime, the application does not crash.
Instead:

- A `console.warn` is emitted with the list of missing runtimes.
- The Settings panel gains a "Bundled runtimes" diagnostic page that lists the
  status of each runtime, marks missing ones with a warning, and shows a
  link to reinstall WeSight.
- The `externalAgentCliInstaller` install methods fall through to their
  existing `npm install -g` / `curl | bash` paths. In a production build
  this should never trigger, but in a developer build it is the expected
  path.

#### 4.4 Call-time failures

The 5 spawn call sites (claude, codex, qwen, opencode, grok, deepseek-tui;
plus the `claudeSettings` SDK loader) handle spawn failures using the
existing error reporting. No new catch chains are introduced. The
`externalAgentCliInstallError` surfaced to the renderer remains the
authoritative error type.

#### 4.5 Mac code signing

`scripts/notarize.js` gains a `codesign --force --deep --sign "Developer ID
Application: <id>"` step. The 8 newly-embedded binaries are signed with the
app's identity and entitlements so the entire bundle passes Gatekeeper and
notarization. If codesign fails, the build aborts with the standard
notarize error.

Caveat: `--deep` replaces the upstream publisher's signature (Node.js
Foundation, Python Software Foundation, GitHub) with WeSight's identity.
This is acceptable for the WeSight distribution but means end users
debugging with `codesign -dv` will see WeSight's identity on every
embedded binary, not the upstream publisher's.

Caveat: `--deep` will recurse into `node_modules/` of the AI engine
bundles and try to sign native `.node` files. This usually succeeds but
may emit warnings. Warnings are tolerated; failures abort the build.

#### 4.7 Windows Authenticode

On Windows, the 8 embedded binaries are re-signed with WeSight's
Authenticode certificate before the NSIS installer is built. This is the
mirror of the macOS `--deep` step:

- `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256
  /f <pfx> /p <password>` is applied to each of the 8 binaries.
- The signing cert is sourced from the same `CSC_LINK` / `CSC_KEY_PASSWORD`
  env vars that electron-builder uses for the main app.
- Without this re-sign, Windows SmartScreen warns (or blocks) end users on
  first launch for each unsigned binary.

The Windows signing step is gated on `process.env.WESIGHT_BUNDLED_RUNTIME_SIGN=1`
in CI; local builds skip it.

#### 4.8 macOS quarantine stripping

When an end user downloads the WeSight DMG from a browser, the entire
`.app` bundle receives a `com.apple.quarantine` extended attribute. The
first time WeSight launches, it runs `xattr -cr` on
`process.resourcesPath/wesight-runtime/` to clear the quarantine xattr
from all 8 bundled binaries. This is required for Python 3.12 (which
refuses to load `.dylib` extensions from quarantined trees) and for
Node 22 native modules (e.g. `better-sqlite3-multiple-ciphers`).

The stripper is idempotent. It runs only if at least one bundled
binary has the `com.apple.quarantine` xattr; subsequent launches
no-op. A `console.info` line records the action.

#### 4.9 Windows Defender exclusion

The NSIS installer (`scripts/nsis-installer.nsh`) gains a one-time
`Add-MpPreference -ExclusionPath <install dir>` step, gated on the
existing `WESIGHT_ENABLE_DEFENDER_EXCLUSION` opt-in flag. Without the
exclusion, Windows Defender quarantines the embedded `python.exe` and
its `.pyd` extensions on first launch. With the exclusion, the launch
succeeds.

If the opt-in flag is not set, WeSight shows a one-time in-app banner
guiding the user to manually add the install dir to the Defender
exclusion list.

#### 4.6 Error-handling principles (codified)

1. **CI phases (fetch, hook, sign)**: fail-fast. No partial releases.
2. **Runtime detection (resolver misses)**: degrade gracefully. Show
   warnings. Never block login.
3. **Call-time failures (spawn errors)**: surface through existing error
   paths. No new catch chains.
4. **Adding a new runtime**: must update the manifest, the CI script, the
   `externalAgentCliInstaller` install method, the resolver, and add a unit
   test. The lint rule enforces this.

### 5. Testing

#### 5.1 Unit tests (vitest, run via `npm test`)

| File | Coverage |
| --- | --- |
| `src/main/runtimeResolver.test.ts` | (a) 8 `tryGetPath` calls return correct absolute paths when binaries exist; (b) missing binaries return `null`; (c) `tryGetAll()` keys match `RuntimeName` constants; (d) `buildPath(name)` produces correct PATH fragment per runtime. |
| `src/shared/runtime/manifest.test.ts` | Manifest schema validation; SHA-256 format check. |
| `scripts/setup-bundled-runtimes.test.cjs` | (a) SHA-256 mismatch throws; (b) manifest write covers all 8 runtimes; (c) directory layout matches the schema. |
| `claudeSettings.test.ts` (additions) | (a) resolver hit → resolver path; (b) resolver miss → asar.unpacked fallback. |
| `externalCliRuntimeAdapter.test.ts` (additions) | Spawn `command` equals resolver path when present; `env.PATH` includes resolver `buildPath` prefix. |
| `externalAgentCliInstaller.test.ts` (additions) | (a) resolver hit returns `binaryPath` and a non-null `version` (run `binary --version` once and cache); (b) resolver miss falls through to `npm install -g`; (c) progress events `starting` → `verifying` → `success` fire on the resolver fast path so the UI does not appear to no-op. |
| `src/main/libs/mcpServerManager.test.ts` (additions) | User-configured MCP server commands take precedence over the resolver default. |
| `src/main/libs/skills/skillLauncher.test.ts` (additions, if exists; otherwise covered by `electron-builder-hooks.cjs` test) | SKILL subprocesses inherit unmodified `PATH`. |
| `scripts/quarantine-stripper.test.cjs` | macOS: detects `com.apple.quarantine` xattr and runs `xattr -cr` on the bundled runtimes directory. Idempotent. |

Target: `npm test` passes with the existing 487 tests plus at least 8 new
runtimeResolver tests, totalling 495+.

#### 5.2 Integration tests (CI matrix + manual smoke)

| Scenario | Platform | Acceptance |
| --- | --- | --- |
| CI pulls 8 runtimes | mac-arm64 runner | `ls vendor/bundled-runtimes/*/<ver>/<platform>/` shows 8 subdirs |
| Build mac | mac-arm64 | `npm run dist:mac:arm64` produces `release/WeSight-<ver>-mac-arm64.dmg` |
| Build win | windows runner | `npm run dist:win` produces `release/WeSight-<ver>-win-x64.exe` |
| Build linux | linux runner | `npm run dist:linux` produces `release/WeSight-<ver>-linux-x64.AppImage` |
| Install check | mac | `find /Applications/WeSight.app/Contents/Resources/wesight-runtime -name '<binary>'` returns all 8 expected binaries |
| Resolver hit at startup | mac | DevTools console: `await window.electron.runtime.getHealth()` returns 8 `{ok: true, version, path}` |
| Claude Code engine end-to-end | mac | Settings → Engine → Claude Code → "Test" passes → cowork session runs to completion |
| CodeX engine end-to-end | mac | Same |
| Hermes engine end-to-end | mac | Same |
| OpenClaw engine end-to-end | mac | Same |
| Bundled node used as SDK subprocess | mac | `ps -ax` during a cowork session shows the `WeSight.app/Contents/Resources/wesight-runtime/.../node` subprocess |
| Missing runtime simulation | mac | `chmod 000 <binary>` then launch → app starts, Settings shows the missing entry, no crash |
| Mac code sign verify | mac | `codesign -dv --verbose=4 <bundled binary>` shows Developer ID signature |
| Windows Defender exclusion | windows | `Get-MpPreference -ExclusionPath` includes WeSight install dir when opt-in flag is set |
| Linux AppImage mount | linux | `--appimage-extract` reveals the bundled runtimes under `squashfs-root/resources/wesight-runtime/` |
| Notarization | mac | `xcrun stapler validate WeSight.dmg` succeeds |
| Gatekeeper fresh install | mac (clean machine) | `spctl --assess --verbose=4 /Applications/WeSight.app` returns accepted |
| macOS quarantine strip on first launch | mac (downloaded DMG) | `xattr -lr <bundled binary>` shows `com.apple.quarantine` before first launch, no quarantine after first launch. Subsequent launches no-op. |
| Windows Defender + bundled Python | windows (clean install) | First launch succeeds; Python loads its `.pyd` extensions without Defender blocking. If blocked, the app shows a one-time banner: "Allow WeSight in Windows Defender to use bundled Python." |
| dev-mode resolver fallback | any | `npm run electron:dev` starts; `runtimeResolver.tryGetAll()` returns 8 nulls; the existing `npm install -g` install path still works for the renderer-driven install flow. |
| MCP server with user-specified command | any | User configures MCP server `command: /usr/local/bin/python3.11`. Resolver's PATH override does NOT shadow the user's command. |
| SKILL subprocess | any | `SKILLs/web-search` starts and runs; its own `node_modules` resolve correctly; resolver's PATH override does NOT affect its subprocess lookups. |

#### 5.3 Merge gate

- [ ] `npm test` green (495+ tests)
- [ ] `npx tsc --noEmit` (renderer + main) clean
- [ ] `npm run lint` clean
- [ ] `npm run dist:mac:arm64` succeeds on mac-arm64 runner
- [ ] `npm run dist:win` succeeds on windows runner
- [ ] `npm run dist:linux` succeeds on linux runner
- [ ] Artifact sizes: mac-arm64 ≤ 1.8 GB, win-x64 ≤ 1.3 GB, linux-x64 ≤ 1.1 GB
- [ ] All 8 binaries pass `fs.accessSync(bin, X_OK)` after install
- [ ] `RuntimeResolver.tryGetAll()` returns 8/8 hits in a packaged build
- [ ] Each of the 4 AI engines completes a cowork session end-to-end
- [ ] Mac code sign + notarize pass
- [ ] Windows SmartScreen does not block a clean install
- [ ] Linux AppImage runs on Ubuntu 22.04 / 24.04
- [ ] Missing-runtime simulation does not block login
- [ ] dev mode starts, `process.resourcesPath` fallback path still works,
      `npm install -g` install path still works
- [ ] `.env.development` is not included in production artifacts
- [ ] `AGENTS.md` updated with `setup-bundled-runtimes` command and a
      "Bundled Runtimes" section listing the 8 runtimes + versions

#### 5.4 Regression guard (lint-enforced)

- `git grep -E "process\\.execPath|@anthropic-ai/claude-agent-sdk/cli\\.js"`
  under `src/main/` returns 0 hits except in the documented fallback path
  inside `claudeSettings.getClaudeCodePath`.
- `git grep -E "spawn\\(['\"](claude|codex|hermes|gh)['\"]"` under `src/main/`
  returns 0 hits.
- `git grep -E "vendor/bundled-runtimes"` under `src/` returns 0 hits.
