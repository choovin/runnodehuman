# WeSight Bundled Runtimes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle Node.js, Python, git, gh, Claude Code, Codex, OpenClaw, and Hermes Agent into WeSight's electron-builder installers so end users get a zero-dependency install.

**Architecture:** CI pulls 8 runtimes from upstream into `vendor/bundled-runtimes/<name>/<ver>/<target>/` with SHA-256 verification. electron-builder's `beforePack` hook verifies the 8 binaries are present; `extraResources` (mac/linux) and the existing `build-tar/win-resources.tar` mechanism (Windows) copy them into the app bundle. A new `RuntimeResolver` is the only path the application uses to look up these binary paths at runtime. `externalAgentCliInstaller`'s `npm install -g` / `curl | bash` paths are preserved as developer-build fallbacks.

**Tech Stack:** Node.js 24, electron-builder 24.13.3, Vitest, electron 40.2.1, electron-builder NSIS (Windows), codesign (mac), signtool (Windows).

**Spec:** `docs/superpowers/specs/2026-06-09-wesight-bundled-runtimes-design.md`

---

## File Structure

### New files
- `scripts/setup-bundled-runtimes.cjs` — CI script that pulls 8 runtimes and writes `vendor/bundled-runtimes/manifest.json`
- `src/shared/runtime/constants.ts` — `RuntimeName` string-literal union
- `src/shared/runtime/manifest.ts` — `RuntimeManifest` types
- `src/main/runtimeResolver.ts` — single resolution entry point
- `src/main/ipcHandlers/runtime.ts` — IPC bridge for the renderer
- `src/main/runtimeResolver.test.ts` — vitest unit tests
- `scripts/setup-bundled-runtimes.test.cjs` — node test runner integration tests

### Modified files (per §2.2 of spec)
Build chain: `package.json`, `electron-builder.json`, `scripts/electron-builder-hooks.cjs`, `scripts/notarize.js`, `scripts/nsis-installer.nsh`, `scripts/openclaw-runtime-host.cjs`, `scripts/sync-openclaw-runtime-current.cjs`, `scripts/sync-local-openclaw-extensions.cjs`, `scripts/bundle-openclaw-gateway.cjs`, `scripts/ensure-openclaw-plugins.cjs`, `scripts/precompile-openclaw-extensions.cjs`, `scripts/prune-openclaw-runtime.cjs`, `scripts/pack-openclaw-tar.cjs`, `scripts/build-openclaw-runtime.sh`, `.gitignore`

Main: `src/main/main.ts`, `src/main/libs/claudeSettings.ts`, `src/main/libs/agentEngine/externalCliRuntimeAdapter.ts`, `src/main/libs/coworkUtil.ts`, `src/main/libs/externalAgentCliInstaller.ts`

Lint/build: `eslint.config.js`, `vite.config.ts`

Docs: `AGENTS.md`

---

## Task ordering rationale

Tasks are ordered so each one produces a self-contained, committable change. Early tasks establish the manifest + resolver skeleton (TDD); middle tasks wire the CI script and the hook; later tasks update the call sites, lint rules, docs, and smoke-test the result. Tests are interleaved with the code they cover, not deferred to the end.

**OpenClaw migration is Task 12a (renumbered from 16)** — it must run *before* Tasks 13/14 (hooks + Windows tar) because the beforePack hook verifies the OpenClaw slice under `vendor/bundled-runtimes/openclaw/<ver>/<target>/`, which only exists after the OpenClaw migration. The original task number 16 was retained as a cross-reference alias.

---

## Task 1: Define the `RuntimeName` union and manifest types

**Files:**
- Create: `src/shared/runtime/constants.ts`
- Create: `src/shared/runtime/manifest.ts`
- Create: `src/shared/runtime/manifest.test.ts`

- [ ] **Step 1: Write the failing test for `manifest.ts`**

```ts
// src/shared/runtime/manifest.test.ts
import { describe, expect, test } from 'vitest';
import { parseRuntimeManifest, RuntimeName } from './manifest';

describe('parseRuntimeManifest', () => {
  test('parses a valid manifest with all 8 runtimes', () => {
    const raw = {
      node: { version: '22.11.0', sha256: 'a'.repeat(64) },
      python: { version: '3.12.7', sha256: 'b'.repeat(64) },
      git: { version: '2.47.1', sha256: 'c'.repeat(64) },
      gh: { version: '2.65.0', sha256: 'd'.repeat(64) },
      claudecode: { version: '1.0.0', sha256: 'e'.repeat(64) },
      codex: { version: '0.1.0', sha256: 'f'.repeat(64) },
      hermes: { version: '2026.4.1', sha256: '1'.repeat(64) },
      openclaw: { version: 'v2026.3.2', sha256: '2'.repeat(64) },
    };
    const r = parseRuntimeManifest(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.node.version).toBe('22.11.0');
      expect(r.value.openclaw.version).toBe('v2026.3.2');
    }
  });

  test('rejects a sha256 that is not 64 hex characters', () => {
    const raw = { node: { version: '22.11.0', sha256: 'too-short' } };
    const r = parseRuntimeManifest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sha256/);
  });

  test('rejects a missing runtime entry', () => {
    const raw = { node: { version: '22.11.0', sha256: 'a'.repeat(64) } };
    const r = parseRuntimeManifest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/runtime/manifest.test.ts`
Expected: FAIL — `./manifest` does not exist.

- [ ] **Step 3: Create `src/shared/runtime/constants.ts`**

```ts
import type { RuntimeManifest } from './manifest';

export const RuntimeName = {
  Node: 'node',
  Python: 'python',
  Git: 'git',
  Gh: 'gh',
  ClaudeCode: 'claudecode',
  Codex: 'codex',
  Hermes: 'hermes',
  OpenClaw: 'openclaw',
} as const;
export type RuntimeName = (typeof RuntimeName)[keyof typeof RuntimeName];

export const RUNTIME_NAMES: readonly RuntimeName[] = Object.values(RuntimeName);

export function isRuntimeName(x: unknown): x is RuntimeName {
  return typeof x === 'string' && (RUNTIME_NAMES as readonly string[]).includes(x);
}

export function getRuntimeManifestKey(name: RuntimeName): keyof RuntimeManifest {
  return name;
}
```

- [ ] **Step 4: Create `src/shared/runtime/manifest.ts`**

```ts
import { RuntimeName } from './constants';

export interface RuntimeVersionSpec {
  version: string;
  sha256: string;
}

export interface RuntimeManifest {
  node: RuntimeVersionSpec;
  python: RuntimeVersionSpec;
  git: RuntimeVersionSpec;
  gh: RuntimeVersionSpec;
  claudecode: RuntimeVersionSpec;
  codex: RuntimeVersionSpec;
  hermes: RuntimeVersionSpec;
  openclaw: RuntimeVersionSpec;
}

export type ParserResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const SHA256_RE = /^[0-9a-f]{64}$/i;

function isVersionSpec(x: unknown): x is RuntimeVersionSpec {
  if (x == null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.version !== 'string' || o.version.length === 0) return false;
  if (typeof o.sha256 !== 'string' || !SHA256_RE.test(o.sha256)) return false;
  return true;
}

export function parseRuntimeManifest(raw: unknown): ParserResult<RuntimeManifest> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest is not an object' };
  }
  const o = raw as Record<string, unknown>;
  for (const name of Object.values(RuntimeName)) {
    if (!isVersionSpec(o[name])) {
      return { ok: false, error: `missing or invalid ${name} entry` };
    }
  }
  return { ok: true, value: o as unknown as RuntimeManifest };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/shared/runtime/manifest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/runtime/
git commit -m "feat(runtime): add RuntimeName union and RuntimeManifest types"
```

---

## Task 2: Implement `RuntimeResolver` (TDD)

**Files:**
- Create: `src/main/runtimeResolver.ts`
- Create: `src/main/runtimeResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/runtimeResolver.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { RuntimeName } from '../shared/runtime/constants';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-resolver-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeBinary(relPath: string): string {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '#!/bin/sh\necho ok\n');
  fs.chmodSync(abs, 0o755);
  return abs;
}

describe('RuntimeResolver', () => {
  test('tryGetPath returns the absolute path for a present binary', async () => {
    const binPath = writeBinary('node/22.11.0/darwin-arm64/bin/node');
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    expect(resolver.tryGetPath('node')).toBe(binPath);
  });

  test('tryGetPath returns null when the binary is missing', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    expect(resolver.tryGetPath('node')).toBeNull();
  });

  test('tryGetPath never throws on any RuntimeName', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    for (const name of Object.values(RuntimeName)) {
      expect(() => resolver.tryGetPath(name)).not.toThrow();
      expect(resolver.tryGetPath(name)).toBeNull();
    }
  });

  test('tryGetAll returns 8 entries (one per RuntimeName), all null when nothing is present', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    const all = resolver.tryGetAll();
    expect(all.size).toBe(8);
    for (const name of Object.values(RuntimeName)) {
      expect(all.get(name)).toBeNull();
    }
  });

  test('buildPath("claudecode") includes the bundled node bin dir', async () => {
    writeBinary('claudecode/1.0.0/darwin-arm64/bin/claude');
    writeBinary('node/22.11.0/darwin-arm64/bin/node');
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    const pathFragment = resolver.buildPath('claudecode');
    expect(pathFragment).toContain('node/22.11.0/darwin-arm64/bin');
    expect(pathFragment).toContain('claudecode/1.0.0/darwin-arm64/bin');
  });

  test('getHealth returns a map keyed by RuntimeName', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot);
    const health = resolver.getHealth();
    expect(health.size).toBe(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/runtimeResolver.test.ts`
Expected: FAIL — `./runtimeResolver` does not exist.

- [ ] **Step 3: Create `src/main/runtimeResolver.ts`**

```ts
// src/main/runtimeResolver.ts
import path from 'path';
import fs from 'fs';
import { RuntimeName } from '../shared/runtime/constants';

const RUNTIME_BINARY: Record<RuntimeName, string> = {
  node: 'bin/node',
  python: 'bin/python3',
  git: 'bin/git',
  gh: 'bin/gh',
  claudecode: 'bin/claude',
  codex: 'bin/codex',
  hermes: 'bin/hermes',
  openclaw: 'openclaw.mjs',
};

const RUNTIME_VERSION: Record<RuntimeName, string> = {
  node: '22.11.0',
  python: '3.12.7',
  git: '2.47.1',
  gh: '2.65.0',
  claudecode: '1.0.0',
  codex: '0.1.0',
  hermes: '2026.4.1',
  openclaw: 'v2026.3.2',
};

const RUNTIME_PLATFORM_DIR: NodeJS.Platform | 'any' = 'any';

export interface ResolvedRuntime {
  name: RuntimeName;
  path: string;
  version: string;
  source: 'bundled';
}

export type ResolvedRuntimeMap = Map<RuntimeName, ResolvedRuntime | null>;

export class RuntimeResolver {
  constructor(private readonly resourcesPath: string) {}

  private slice(): string {
    const platform =
      process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'win32'
          ? 'win32'
          : 'linux';
    const arch =
      process.arch === 'arm64'
        ? 'arm64'
        : process.arch === 'ia32'
          ? 'ia32'
          : 'x64';
    return `${platform}-${arch}`;
  }

  private rootFor(name: RuntimeName): string {
    return path.join(
      this.resourcesPath,
      'wesight-runtime',
      name,
      RUNTIME_VERSION[name],
      this.slice()
    );
  }

  tryGetPath(name: RuntimeName): string | null {
    const binary = RUNTIME_BINARY[name];
    const fullPath = path.join(this.rootFor(name), binary);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      return null;
    }
  }

  tryGetAll(): ResolvedRuntimeMap {
    const map: ResolvedRuntimeMap = new Map();
    for (const name of Object.values(RuntimeName)) {
      const p = this.tryGetPath(name);
      map.set(
        name,
        p === null ? null : { name, path: p, version: RUNTIME_VERSION[name], source: 'bundled' }
      );
    }
    return map;
  }

  buildPath(name: RuntimeName): string {
    // PATH fragment for this runtime. Includes:
    //   - the binary's own bin dir
    //   - for claudecode/codex/hermes/openclaw: bundled node's bin dir
    //     (so shebangs like #!/usr/bin/env node resolve to bundled node)
    const slice = this.slice();
    const parts: string[] = [];
    const ownRoot = path.join(this.resourcesPath, 'wesight-runtime', name, RUNTIME_VERSION[name], slice);
    parts.push(path.join(ownRoot, 'bin'));
    if (name !== 'node') {
      const nodeRoot = path.join(this.resourcesPath, 'wesight-runtime', 'node', RUNTIME_VERSION.node, slice);
      parts.push(path.join(nodeRoot, 'bin'));
    }
    return parts.join(path.delimiter);
  }

  getHealth(): ResolvedRuntimeMap {
    return this.tryGetAll();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/runtimeResolver.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/runtimeResolver.ts src/main/runtimeResolver.test.ts
git commit -m "feat(runtime): add RuntimeResolver module"
```

---

## Task 3: Wire `RuntimeResolver` into main.ts startup

**Files:**
- Modify: `src/main/main.ts` (add resolver init + IPC registration)

- [ ] **Step 1: Find the `initApp` entry point**

Run: `grep -n "initApp\|whenReady\|app.whenReady" src/main/main.ts | head -10`

- [ ] **Step 2: Add the resolver import and singleton**

Insert at the top of `src/main/main.ts`, after the existing imports:

```ts
import { RuntimeResolver } from './runtimeResolver';
import { registerRuntimeHandlers } from './ipcHandlers/runtime';
```

- [ ] **Step 3: Locate where services are instantiated**

Find the section near `app.whenReady()` that creates `cloudAuthService`, `cloudPlatformProviderService`, etc. Add the resolver and the IPC registration right after the existing services are created.

```ts
// After existing service singletons are created
const runtimeResolver = new RuntimeResolver(process.resourcesPath);
const runtimeHealth = runtimeResolver.tryGetAll();
const missing = Array.from(runtimeHealth.entries())
  .filter(([, v]) => v === null)
  .map(([k]) => k);
if (missing.length > 0) {
  console.warn('[RuntimeResolver] missing runtimes:', missing.join(', '));
} else {
  console.info('[RuntimeResolver] all 8 runtimes resolved from bundled resources');
}
registerRuntimeHandlers(runtimeResolver);
```

- [ ] **Step 4: Create `src/main/ipcHandlers/runtime.ts`**

```ts
import { ipcMain } from 'electron';
import { RuntimeName } from '../../shared/runtime/constants';
import type { RuntimeResolver } from '../runtimeResolver';

export const RuntimeIpcChannel = {
  GetHealth: 'runtime:get-health',
} as const;

export interface SerializedRuntimeHealth {
  ok: true;
  runtimes: Array<{
    name: RuntimeName;
    ok: boolean;
    path: string | null;
    version: string;
  }>;
}

export function registerRuntimeHandlers(resolver: RuntimeResolver): void {
  ipcMain.handle(RuntimeIpcChannel.GetHealth, (): SerializedRuntimeHealth => {
    const health = resolver.getHealth();
    const runtimes = Array.from(health.entries()).map(([name, value]) => ({
      name,
      ok: value !== null,
      path: value === null ? null : value.path,
      version: value === null ? '' : value.version,
    }));
    return { ok: true, runtimes };
  });
}
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --project electron-tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts src/main/ipcHandlers/runtime.ts
git commit -m "feat(runtime): wire RuntimeResolver into main process startup"
```

---

## Task 4: Update `claudeSettings.getClaudeCodePath` to prefer the resolver

**Files:**
- Modify: `src/main/libs/claudeSettings.ts` (lines 101-119)

- [ ] **Step 1: Read the current `getClaudeCodePath`**

Run: `sed -n '95,125p' src/main/libs/claudeSettings.ts`

- [ ] **Step 2: Add the resolver import**

Insert at the top of `claudeSettings.ts`, after existing imports:

```ts
import { RuntimeResolver } from '../runtimeResolver';
```

- [ ] **Step 3: Export a singleton resolver**

```ts
let runtimeResolver: RuntimeResolver | null = null;
export function setRuntimeResolver(r: RuntimeResolver): void {
  runtimeResolver = r;
}
```

- [ ] **Step 4: Update `getClaudeCodePath` to prefer the resolver**

Replace the body of `getClaudeCodePath` (after the asar.unpacked lookup) with:

```ts
export function getClaudeCodePath(): string {
  if (app.isPackaged) {
    const resolverPath = runtimeResolver?.tryGetPath('claudecode');
    if (resolverPath) return resolverPath;
  }
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'cli.js'
    );
  }
  const appPath = app.getAppPath();
  const rootDir = appPath.endsWith('dist-electron') ? join(appPath, '..') : appPath;
  return join(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
}
```

- [ ] **Step 5: Wire the resolver in main.ts**

In `main.ts`, after `const runtimeResolver = new RuntimeResolver(...)`:

```ts
import { setRuntimeResolver } from './libs/claudeSettings';
setRuntimeResolver(runtimeResolver);
```

- [ ] **Step 6: Add the spec-required test cases for `claudeSettings.test.ts`**

If `src/main/libs/claudeSettings.test.ts` does not already test the
resolver-aware path, add two cases (per spec §5.1):

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getClaudeCodePath, setRuntimeResolver } from './claudeSettings';
import { RuntimeResolver } from '../runtimeResolver';

describe('getClaudeCodePath with RuntimeResolver', () => {
  afterEach(() => {
    setRuntimeResolver(null as unknown as RuntimeResolver);
  });

  test('prefers resolver path in packaged build when resolver returns a value', () => {
    const fakeResolver = {
      tryGetPath: vi.fn((name: string) => name === 'claudecode' ? '/bundled/claude' : null),
    } as unknown as RuntimeResolver;
    setRuntimeResolver(fakeResolver);
    // Stub app.isPackaged to true
    vi.mock('electron', () => ({ app: { isPackaged: true } }));
    expect(getClaudeCodePath()).toBe('/bundled/claude');
  });

  test('falls back to asar.unpacked path when resolver returns null', () => {
    const fakeResolver = {
      tryGetPath: vi.fn(() => null),
    } as unknown as RuntimeResolver;
    setRuntimeResolver(fakeResolver);
    vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/app' } }));
    // Path under app.asar.unpacked is returned
    const path = getClaudeCodePath();
    expect(path).toContain('app.asar.unpacked');
    expect(path).toContain('claude-agent-sdk');
  });
});
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npx tsc --project electron-tsconfig.json --noEmit && npx vitest run src/main/libs/claudeSettings.test.ts`
Expected: clean typecheck; existing tests + 2 new resolver tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/libs/claudeSettings.ts src/main/main.ts
git commit -m "feat(ai-engines): prefer bundled claudecode path in packaged build"
```

---

## Task 5: Update `externalCliRuntimeAdapter` spawn path to use the resolver

**Files:**
- Modify: `src/main/libs/agentEngine/externalCliRuntimeAdapter.ts` (around `resolveSpawnCommandSpec`)

- [ ] **Step 1: Read the current spawn spec builder**

Run: `grep -n "resolveSpawnCommandSpec\|getCommandName\|claude\|codex" src/main/libs/agentEngine/externalCliRuntimeAdapter.ts | head -20`

- [ ] **Step 2: Add the resolver import and singleton wiring**

Add to the top of `externalCliRuntimeAdapter.ts`:

```ts
import { RuntimeName } from '../../../shared/runtime/constants';
import type { RuntimeResolver } from '../../runtimeResolver';

let runtimeResolver: RuntimeResolver | null = null;
export function setRuntimeResolver(r: RuntimeResolver): void {
  runtimeResolver = r;
}
```

- [ ] **Step 3: Map in-scope engine names to RuntimeName**

Only the 3 in-scope engines (`claude`, `codex`, `hermes`) are in the bundled-runtime set. The other engines (`qwen`, `opencode`, `grok`, `deepseek-tui`) are NOT in the 8-bundled list — they continue to use the existing `npm install -g` / `curl | bash` install path and are looked up on the host's `PATH` at spawn time. Restrict the helper to the 3 in-scope engines only:

```ts
function engineToRuntimeName(command: string): RuntimeName | null {
  switch (command) {
    case 'claude': return RuntimeName.ClaudeCode;
    case 'codex': return RuntimeName.Codex;
    case 'hermes': return RuntimeName.Hermes;
    default: return null;
  }
}
```

When `engineToRuntimeName` returns `null`, the spawn site continues to use
the existing `resolveSpawnCommandSpec` PATH lookup unchanged. The
`externalAgentCliInstaller` install path for the non-bundled engines is
preserved verbatim.

- [ ] **Step 4: Patch `resolveSpawnCommandSpec` to use the resolver for in-scope engines**

Find the function that resolves the command name to a path (search for `resolveSpawnCommandSpec` or `command:` near the spawn call). At the top of that function, before any other resolution, add a resolver fast-path that returns the command name unchanged (so the existing caller doesn't need to change shape) and a side-channel for PATH:

```ts
const resolverName = engineToRuntimeName(command);
if (resolverName && runtimeResolver) {
  const resolved = runtimeResolver.tryGetPath(resolverName);
  if (resolved) {
    // Stash the prependPath for the spawn site to read. The spawn site
    // (around line 463 of this file) calls `applySpawnEnvOverrides(env, ...)
    // which we extend in Task 6 to consult this side-channel.
    pendingPrependPath = runtimeResolver.buildPath(resolverName);
    return { command: resolved };
  }
}
```

`pendingPrependPath` is a module-level variable in
`externalCliRuntimeAdapter.ts`. The spawn site reads it before
constructing `env`:

```ts
if (pendingPrependPath) {
  env.PATH = pendingPrependPath + (env.PATH ? path.delimiter + env.PATH : '');
  pendingPrependPath = null;
}
```

(Alternative: thread a `prependPath: string | null` through the existing
return value if the current function signature can be widened without
breaking callers. The side-channel above is a fallback if widening is
invasive.)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --project electron-tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/agentEngine/externalCliRuntimeAdapter.ts
git commit -m "feat(ai-engines): resolve claudecode/codex/hermes via RuntimeResolver"
```

---

## Task 6: Prepend resolver PATH in `coworkUtil.buildEnvForConfig`

**Files:**
- Modify: `src/main/libs/coworkUtil.ts`

- [ ] **Step 1: Locate `getEnhancedEnv` and `applyPackagedEnvOverrides`**

Run: `grep -n "getEnhancedEnv\|applyPackagedEnvOverrides\|env.PATH" src/main/libs/coworkUtil.ts | head -20`

- [ ] **Step 2: Add the resolver import and setter**

```ts
import type { RuntimeResolver } from './runtimeResolver';
let runtimeResolver: RuntimeResolver | null = null;
export function setRuntimeResolver(r: RuntimeResolver): void {
  runtimeResolver = r;
}
```

- [ ] **Step 3: Inject the resolver's `buildPath` into the env**

In `getEnhancedEnv` (or in `applyPackagedEnvOverrides` if that is the right site), after `env` is built, prepend the resolver's PATH fragment:

```ts
if (runtimeResolver) {
  const claudecodePath = runtimeResolver.buildPath('claudecode');
  env.PATH = claudecodePath + (env.PATH ? ':' + env.PATH : '');
}
```

- [ ] **Step 4: Wire the resolver in main.ts**

After `const runtimeResolver = new RuntimeResolver(...)`:

```ts
import { setRuntimeResolver as setCoworkUtilResolver } from './libs/coworkUtil';
setCoworkUtilResolver(runtimeResolver);
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --project electron-tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/coworkUtil.ts src/main/main.ts
git commit -m "feat(env): prepend bundled runtime bin paths to subprocess env"
```

---

## Task 7: Short-circuit `externalAgentCliInstaller` on resolver hit

**Files:**
- Modify: `src/main/libs/externalAgentCliInstaller.ts`

- [ ] **Step 1: Find each `install<Runtime>` method head**

Run: `grep -n "async install\|runInstall\|phase" src/main/libs/externalAgentCliInstaller.ts | head -30`

- [ ] **Step 2: Add the resolver import and singleton**

```ts
import { RuntimeName } from '../../shared/runtime/constants';
import type { RuntimeResolver } from '../runtimeResolver';

let runtimeResolver: RuntimeResolver | null = null;
export function setRuntimeResolver(r: RuntimeResolver): void {
  runtimeResolver = r;
}
```

- [ ] **Step 3: Add a helper at the top of the file**

```ts
function appTypeToRuntimeName(appType: CliAppType): RuntimeName | null {
  switch (appType) {
    case 'claude': return RuntimeName.ClaudeCode;
    case 'codex': return RuntimeName.Codex;
    case 'hermes': return RuntimeName.Hermes;
    case 'openclaw': return RuntimeName.OpenClaw;
    default: return null;
  }
}
```

- [ ] **Step 4: Add a fast-path method**

```ts
private async tryBundledPath(appType: CliAppType): Promise<ExternalAgentCliInstallResult | null> {
  const resolverName = appTypeToRuntimeName(appType);
  if (!resolverName || !runtimeResolver) return null;
  const binaryPath = runtimeResolver.tryGetPath(resolverName);
  if (!binaryPath) return null;

  this.emit({ appType, phase: 'starting', message: 'Detected bundled runtime' });
  this.emit({ appType, phase: 'verifying', message: binaryPath });
  let version: string | null = null;
  try {
    const { spawn } = await import('child_process');
    const out = spawn.sync(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
    version = (out.stdout || out.stderr || '').trim().split('\n')[0] || null;
  } catch (e) {
    return null;
  }
  this.emit({ appType, phase: 'success', message: 'Bundled runtime ready' });
  return {
    success: true,
    appType,
    installMethod: 'bundled',
    command: appType,
    binaryPath,
    version,
  };
}
```

- [ ] **Step 5: Wire the fast path into the public entry point**

Find the public `runInstall` / `install` method. Add at the top:

```ts
const bundled = await this.tryBundledPath(appType);
if (bundled) return bundled;
```

- [ ] **Step 6: Wire the resolver in main.ts**

After `const runtimeResolver = ...`:

```ts
import { setRuntimeResolver as setInstallerResolver } from './libs/externalAgentCliInstaller';
setInstallerResolver(runtimeResolver);
```

- [ ] **Step 7: Run typecheck and tests**

If `src/main/libs/externalAgentCliInstaller.test.ts` does not exist, create it first with the spec's required test cases:

```ts
// src/main/libs/externalAgentCliInstaller.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExternalAgentCliInstaller } from './externalAgentCliInstaller';
import { setRuntimeResolver } from './externalAgentCliInstaller';
import { RuntimeName } from '../../shared/runtime/constants';
import { RuntimeResolver } from '../runtimeResolver';

let installer: ExternalAgentCliInstaller;
let fakeResolver: RuntimeResolver;

beforeEach(() => {
  fakeResolver = {
    tryGetPath: vi.fn().mockReturnValue('/bundled/bin/claude'),
    buildPath: vi.fn().mockReturnValue('/bundled/bin'),
  } as unknown as RuntimeResolver;
  setRuntimeResolver(fakeResolver);
});

afterEach(() => {
  setRuntimeResolver(null as unknown as RuntimeResolver);
});

describe('ExternalAgentCliInstaller fast path', () => {
  test('returns bundled binaryPath and version on resolver hit', async () => {
    // stub spawn for --version
    vi.mock('child_process', () => ({
      spawn: { sync: vi.fn().mockReturnValue({ stdout: '1.0.0\n', stderr: '' }) },
    }));
    installer = new ExternalAgentCliInstaller();
    const r = await installer.runInstall('claude');
    expect(r.success).toBe(true);
    expect(r.installMethod).toBe('bundled');
    expect(r.binaryPath).toBe('/bundled/bin/claude');
  });
  test('falls through to npm install -g when resolver returns null', async () => {
    setRuntimeResolver({ tryGetPath: () => null, buildPath: () => '' } as unknown as RuntimeResolver);
    // existing npm-install path is exercised by the existing test suite
  });
});
```

Then run: `npx tsc --project electron-tsconfig.json --noEmit && npx vitest run src/main/libs/externalAgentCliInstaller.test.ts 2>&1 | tail -20`
Expected: clean typecheck; existing tests + new tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/libs/externalAgentCliInstaller.ts src/main/main.ts
git commit -m "feat(installer): prefer bundled runtime path when available"
```

---

## Task 8: Implement `setup-bundled-runtimes.cjs` (CI script)

**Files:**
- Create: `scripts/setup-bundled-runtimes.cjs`
- Create: `scripts/setup-bundled-runtimes.test.cjs`
- Modify: `package.json` (add script + `runtimeManifest` field)

- [ ] **Step 1: Add `runtimeManifest` to `package.json`**

Insert at the top of `package.json`, before `"main"`:

```json
"runtimeManifest": {
  "node": { "version": "22.11.0", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "python": { "version": "3.12.7", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "git": { "version": "2.47.1", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "gh": { "version": "2.65.0", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "claudecode": { "version": "1.0.0", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "codex": { "version": "0.1.0", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "hermes": { "version": "2026.4.1", "sha256": "REPLACE_AFTER_FIRST_FETCH" },
  "openclaw": { "version": "v2026.3.2", "sha256": "REPLACE_AFTER_FIRST_FETCH" }
},
```

The `REPLACE_AFTER_FIRST_FETCH` placeholder is filled in by the first successful CI run.

- [ ] **Step 2: Add the npm script and chain it into all dist scripts**

In the `scripts` section of `package.json`, add:

```json
"setup-bundled-runtimes": "node scripts/setup-bundled-runtimes.cjs"
```

Then update all 8 `dist:*` scripts to include the setup step. Read the current
scripts block, then for each of these existing scripts, prepend
`npm run setup-bundled-runtimes &&` (after the `predist:*` reference, which
already includes the step):

- `dist:mac`: becomes `npm run predist:mac && npm run setup-bundled-runtimes && electron-builder --mac --config electron-builder.json`
- `dist:mac:x64`: same with `--x64`
- `dist:mac:arm64`: same with `--arm64`
- `dist:mac:universal`: same with `--universal`
- `dist:win`: same with `--win --x64`
- `dist:linux`: same with `--linux`
- `pack` and `dist` (the unsuffixed top-level scripts): same treatment

The `predist:*` chain order is:
- `predist:mac`: `npm run build && npm run setup-bundled-runtimes && npm run compile:electron && npm run build:skills`
- `predist:win`: `npm run setup:python-runtime && npm run build && npm run setup-bundled-runtimes && npm run compile:electron && npm run build:skills`
- `predist:linux`: same as `predist:mac` (no Windows Python)

`setup-bundled-runtimes` must run before `compile:electron` so the
`beforePack` hook can verify the runtime slices exist when electron-builder
runs.

- [ ] **Step 3: Write the failing integration test**

```js
// scripts/setup-bundled-runtimes.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('parseManifest throws on a missing runtime', () => {
  const { parseManifest } = require('./setup-bundled-runtimes.cjs');
  assert.throws(() => parseManifest({ node: { version: '1', sha256: 'a'.repeat(64) } }), /missing/);
});

test('parseManifest throws on an invalid sha256', () => {
  const { parseManifest } = require('./setup-bundled-runtimes.cjs');
  assert.throws(() => parseManifest({ node: { version: '1', sha256: 'short' } }), /sha256/);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test scripts/setup-bundled-runtimes.test.cjs`
Expected: FAIL — `./setup-bundled-runtimes.cjs` does not exist.

- [ ] **Step 5: Create `scripts/setup-bundled-runtimes.cjs`**

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Lazily read package.json so importing this module from tests does not
// crash if the working directory is not the project root.
function readRuntimeManifest() {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).runtimeManifest;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

function parseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('runtimeManifest missing or invalid in package.json');
  }
  for (const name of ['node', 'python', 'git', 'gh', 'claudecode', 'codex', 'hermes', 'openclaw']) {
    const spec = manifest[name];
    if (!spec || typeof spec !== 'object') throw new Error(`runtimeManifest: missing ${name}`);
    if (typeof spec.version !== 'string' || spec.version.length === 0) {
      throw new Error(`runtimeManifest: missing ${name}.version`);
    }
    if (typeof spec.sha256 !== 'string' || !SHA256_RE.test(spec.sha256)) {
      throw new Error(`runtimeManifest: ${name}.sha256 must be 64 hex chars`);
    }
  }
  return manifest;
}

function vendorDir(name, version) {
  return path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', name, version);
}

function slicePath(name, version, platform, arch) {
  return path.join(vendorDir(name, version), `${platform}-${arch}`);
}

function sha256OfFile(absPath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(absPath));
  return h.digest('hex');
}

async function downloadTo(url, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const file = fs.createWriteStream(destAbs);
  await pipeline(Readable.fromWeb(res.body), file);
}

async function downloadAndVerify({ name, version, url, destRel, expectedSha256 }) {
  const destAbs = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', name, version, destRel);
  await downloadTo(url, destAbs);
  const actual = sha256OfFile(destAbs);
  if (actual !== expectedSha256) {
    fs.rmSync(destAbs, { force: true });
    throw new Error(`${name}: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  return destAbs;
}

function writeManifestSlice(name, version, slice, files) {
  const sliceRoot = path.join(vendorDir(name, version), slice);
  fs.mkdirSync(sliceRoot, { recursive: true });
  fs.writeFileSync(path.join(sliceRoot, 'slice.json'), JSON.stringify({ name, version, slice, files }, null, 2));
}

async function fetchNode(version) {
  // Each platform: download the official tarball/zip and extract into the slice.
  // Implementation note: actual URLs and extraction steps are filled in by the
  // first CI run. The structure (one directory per (name, version, slice)) is
  // what downstream code reads.
  throw new Error('fetchNode not yet implemented; see Task 8 step 5 notes');
}

async function fetchPython() { throw new Error('fetchPython not yet implemented'); }
async function fetchGit() { throw new Error('fetchGit not yet implemented'); }
async function fetchGh() { throw new Error('fetchGh not yet implemented'); }
async function fetchClaudeCode() { throw new Error('fetchClaudeCode not yet implemented'); }
async function fetchCodex() { throw new Error('fetchCodex not yet implemented'); }
async function fetchHermes() { throw new Error('fetchHermes not yet implemented'); }
async function fetchOpenClaw() { throw new Error('fetchOpenClaw not yet implemented'); }

async function main() {
  const RUNTIME_MANIFEST = readRuntimeManifest();
  parseManifest(RUNTIME_MANIFEST);
  const slice = (() => {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64';
    return `${platform}-${arch}`;
  })();
  console.log(`[setup-bundled-runtimes] target slice: ${slice}`);

  const fetchers = {
    node: fetchNode,
    python: fetchPython,
    git: fetchGit,
    gh: fetchGh,
    claudecode: fetchClaudeCode,
    codex: fetchCodex,
    hermes: fetchHermes,
    openclaw: fetchOpenClaw,
  };
  for (const [name, fetcher] of Object.entries(fetchers)) {
    const spec = RUNTIME_MANIFEST[name];
    console.log(`[setup-bundled-runtimes] fetching ${name}@${spec.version} for ${slice}...`);
    await fetcher(spec.version, slice, spec.sha256);
  }
  console.log('[setup-bundled-runtimes] done');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[setup-bundled-runtimes] FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { parseManifest, slicePath, vendorDir };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test scripts/setup-bundled-runtimes.test.cjs`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/setup-bundled-runtimes.cjs scripts/setup-bundled-runtimes.test.cjs
git commit -m "feat(build): add setup-bundled-runtimes cjs skeleton"
```

> **Note:** The 8 `fetch*` functions are intentionally stubbed in this task. They will be implemented one per platform in Tasks 9-11 below. Tests cover `parseManifest` only; the actual fetch URLs are filled in by the first CI run when real upstream artifacts are downloaded.

---

## Task 9: Implement `fetchNode` (Task 8 stub)

**Files:**
- Modify: `scripts/setup-bundled-runtimes.cjs`

- [ ] **Step 1: Replace the `fetchNode` stub**

```js
const NODE_BASE = 'https://nodejs.org/dist';
const tar = require('tar');

async function fetchNode(version, slice) {
  const [platform, arch] = slice.split('-');
  let url, archiveType;
  if (platform === 'darwin') {
    url = `${NODE_BASE}/v${version}/node-v${version}-darwin-${arch}.tar.xz`;
    archiveType = 'tar.xz';
  } else if (platform === 'linux') {
    url = `${NODE_BASE}/v${version}/node-v${version}-linux-${arch}.tar.xz`;
    archiveType = 'tar.xz';
  } else if (platform === 'win32') {
    url = `${NODE_BASE}/v${version}/node-v${version}-win-x64.7z`;
    archiveType = '7z';
  }
  if (!url) throw new Error(`unsupported node slice: ${slice}`);
  const destRel = `node-v${version}-${platform}-${arch}.${archiveType.split('.').pop()}`;
  const destAbs = await downloadAndVerify({
    name: 'node',
    version,
    url,
    destRel,
    expectedSha256: RUNTIME_MANIFEST.node.sha256,
  });
  // Use the `tar` npm package (cross-platform; no host `tar` binary needed).
  const extractRoot = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', 'node', version, slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({
    file: destAbs,
    cwd: extractRoot,
    strip: 1,
  });
  fs.rmSync(destAbs);
}
```

Note: `tar` is already a project dependency (used by
`scripts/pack-openclaw-tar.cjs`), so no new dependency is added.

- [ ] **Step 2: Test manually on host**

Run: `npm run setup-bundled-runtimes` (only after the manifest's `node.sha256` is filled in by an earlier run; for first-time local testing, use the `--dry-run` flag added in Task 8 or replace the `expectedSha256` with a sentinel). The exact reproduction requires network access to `nodejs.org` and the actual SHA-256; for CI this is the first concrete run.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-bundled-runtimes.cjs
git commit -m "feat(build): implement node runtime fetch in setup-bundled-runtimes"
```

---

## Task 10: Implement the other 7 fetch functions (Task 8 stubs)

**Files:**
- Modify: `scripts/setup-bundled-runtimes.cjs`

- [ ] **Step 1: Replace `fetchPython`, `fetchGit`, `fetchGh`, `fetchClaudeCode`, `fetchCodex`, `fetchHermes`, `fetchOpenClaw` stubs**

Each function follows the same shape: pick the right upstream URL per (platform, arch), download, verify SHA-256, extract into the slice dir. OpenClaw reuses the existing `npm run openclaw:runtime:<target>` flow (call it as a subprocess and pass through the existing logic).

```js
// fetchPython: python.org
//   mac:    https://www.python.org/ftp/python/<v>/python-<v>-macos11.pkg
//   linux:  https://www.python.org/ftp/python/<v>/Python-<v>.tar.xz  (build from source)
//   win32:  https://www.python.org/ftp/python/<v>/python-<v>-embed-amd64.zip
//
// fetchGit: git-scm.com
//   mac:    https://git-scm.com/download/mac  (build from source tar)
//   linux:  system git  (no fetch; fall back to PATH at runtime)
//   win32:  https://github.com/git-for-windows/git/releases/download/v<ver>/MinGit-<ver>-64-bit.zip
//
// fetchGh: github.com/cli/cli releases
//   all:    https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_<platform>_<arch>.tar.gz
//
// fetchClaudeCode, fetchCodex: npm pack
//   all:    npm pack <package>@<version> + tar -xf
//
// fetchHermes: github.com/NousResearch/hermes-agent
//   all:    https://github.com/NousResearch/hermes-agent/releases/download/<ver>/hermes-agent-<platform>-<arch>.<ext>
//
// fetchOpenClaw: shell out to existing `npm run openclaw:runtime:<target>` and the existing per-target scripts.
```

Implement each one with the same `downloadAndVerify` + `execFileSync('tar', ...)` pattern as `fetchNode`. For OpenClaw, shell out to the existing build chain (the `openclaw:runtime:<target>` scripts already produce a tree at `vendor/openclaw-runtime/<target>/`; after Task 13's migration, that path becomes `vendor/bundled-runtimes/openclaw/<ver>/<target>/`).

- [ ] **Step 2: Run the script on a real CI runner (mac-arm64)**

Run: `npm run setup-bundled-runtimes`
Expected: all 8 runtimes fetched, SHA-256 verified, slices laid out under `vendor/bundled-runtimes/<name>/<ver>/<platform>-<arch>/`. The CI step populates the actual SHA-256 values into `package.json:runtimeManifest` for the next run.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-bundled-runtimes.cjs
git commit -m "feat(build): implement all 8 runtime fetchers"
```

---

## Task 11: Add mac/linux `extraResources` entries to `electron-builder.json`

**Files:**
- Modify: `electron-builder.json`

- [ ] **Step 1: Read the current `mac` and `linux` blocks**

Run: `sed -n '78,150p' electron-builder.json`

- [ ] **Step 2: Add `extraResources` for the wesight-runtime directory under `mac.extraResources`**

Inside the `mac` block, after the existing `extraResources` array, prepend a new entry for each of the 8 runtimes. The `from` path includes the **platform-arch slice** (so each mac build only carries the slices it needs):

```json
{
  "from": "vendor/bundled-runtimes/node/${nodeVersion}/darwin-arm64",
  "to": "wesight-runtime/node",
  "filter": ["**/*"]
},
{
  "from": "vendor/bundled-runtimes/python/${pythonVersion}/darwin-arm64",
  "to": "wesight-runtime/python",
  "filter": ["**/*"]
}
```

(… and similarly for the other 6 runtimes.)

The `${nodeVersion}` / `${pythonVersion}` / etc. are electron-builder template
substitutions. The hook in Task 12 sets these env vars before invoking
electron-builder by reading them from `package.json:runtimeManifest`:

```js
// in electron-builder-hooks.cjs:beforePack
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
for (const [name, spec] of Object.entries(pkg.runtimeManifest)) {
  process.env[`WESIGHT_BUNDLED_RUNTIME_VERSION_${name.toUpperCase()}`] = spec.version;
}
```

(These env vars are local to the beforePack context; they are not consumed
in the hook itself but are read by electron-builder's template
substitution when it processes `extraResources`.)

The `from` path includes the **slice** (e.g. `darwin-arm64`) so the
`extraResources` copy only pulls the current target's slice into the
bundle, not all slices.

- [ ] **Step 3: Add the same entries under `linux.extraResources`**

Identical structure to mac, but with `linux-x64` / `linux-arm64` in the
`from` path. Add **two** entries per runtime (one for x64, one for
arm64) so the same `linux.extraResources` array works for both
`--linux --x64` and `--linux --arm64` invocations.

- [ ] **Step 4: For Windows, do not add `extraResources`; instead extend the existing tar**

This is implemented in Task 12 (the hook).

- [ ] **Step 5: Run typecheck (no impact but sanity check)**

Run: `npx tsc --project electron-tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add electron-builder.json
git commit -m "feat(build): add wesight-runtime to mac and linux extraResources"
```

---

## Task 12: Extend `beforePack` to verify + extend `afterPack` for Windows signtool

**Files:**
- Modify: `scripts/electron-builder-hooks.cjs`

> **EXECUTION ORDER NOTE:** This task must run **after** Task 16 (OpenClaw migration). The OpenClaw slice at `vendor/bundled-runtimes/openclaw/<ver>/<target>/` is required for the beforePack verification to pass. If you execute tasks in numeric order, **pause after Task 11 and run Task 16 before continuing**.

- [ ] **Step 1: Read the current `beforePack` function**

Run: `sed -n '489,560p' scripts/electron-builder-hooks.cjs`

- [ ] **Step 2: Add a verification block at the end of `beforePack`**

At the end of `beforePack`, before the existing `applyMacIconFix` (or equivalent), add:

```js
// Verify all 8 bundled runtimes are present for the current target.
// Versions are read directly from package.json:runtimeManifest, not from
// process.env, so the hook works regardless of how electron-builder was
// invoked.
const runtimeManifest = (() => {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.runtimeManifest;
})();
const targetId = resolveOpenClawRuntimeTargetId(context);
for (const name of Object.keys(runtimeManifest)) {
  const spec = runtimeManifest[name];
  const slicePath = path.join(__dirname, '..', 'vendor', 'bundled-runtimes', name, spec.version, targetId);
  if (!existsSync(slicePath)) {
    throw new Error(`[electron-builder-hooks] Runtime ${name}@${spec.version} missing for target ${targetId}. Run 'npm run setup-bundled-runtimes' first.`);
  }
}
console.log(`[electron-builder-hooks] Verified all 8 runtimes for target ${targetId}.`);
```

- [ ] **Step 3: Add the Windows signtool step in `afterPack`**

Find the `afterPack(context)` function. At the end, add:

```js
  if (process.platform === 'win32' && process.env.WESIGHT_BUNDLED_RUNTIME_SIGN === '1') {
    const runtimeNames = ['node', 'python', 'git', 'gh', 'claudecode', 'codex', 'hermes', 'openclaw'];
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    for (const name of runtimeNames) {
      const version = pkg.runtimeManifest?.[name]?.version;
      if (!version) continue;
      const binaryRel = ({
        node: 'bin/node.exe',
        python: 'python.exe',
        git: 'bin/git.exe',
        gh: 'bin/gh.exe',
        claudecode: 'bin/claude.cmd',
        codex: 'bin/codex.cmd',
        hermes: 'bin/hermes.exe',
        openclaw: 'openclaw.mjs',
      })[name];
      if (!binaryRel) continue;
      const binaryAbs = path.join(context.appOutDir, 'resources', 'wesight-runtime', name, version, 'win-x64', binaryRel);
      if (!existsSync(binaryAbs)) continue;
      const { spawnSync } = require('child_process');
      const r = spawnSync('signtool', [
        'sign', '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256',
        '/f', process.env.CSC_LINK || '', '/p', process.env.CSC_KEY_PASSWORD || '',
        binaryAbs,
      ], { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error(`[electron-builder-hooks] signtool failed for ${binaryAbs} (status ${r.status})`);
      }
    }
    console.log('[electron-builder-hooks] Signed all 8 Windows runtimes.');
  }
```

- [ ] **Step 4: Run typecheck (no impact but sanity check)**

Run: `npx tsc --project electron-tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/electron-builder-hooks.cjs
git commit -m "feat(build): verify 8 runtimes in beforePack; sign Windows runtimes in afterPack"
```

---

## Task 13: Extend Windows `build-tar/win-resources.tar` to include `wesight-runtime/`

**Files:**
- Modify: `scripts/electron-builder-hooks.cjs` (in the Windows-only branch of `beforePack`)

- [ ] **Step 1: Find the existing tar pack code**

Run: `grep -n "win-resources.tar\|packMultipleSources" scripts/electron-builder-hooks.cjs`

- [ ] **Step 2: Add wesight-runtime sources to the tar pack**

The existing tar pack builds a sources list and calls `packMultipleSources(sources, outputTar)`. Add 8 entries to that sources list, one per runtime, pointing at `vendor/bundled-runtimes/<name>/<ver>/win-x64/`:

```js
const runtimeNames = ['node', 'python', 'git', 'gh', 'claudecode', 'codex', 'hermes', 'openclaw'];
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
for (const name of runtimeNames) {
  const version = pkg.runtimeManifest?.[name]?.version;
  if (!version) continue;
  const src = path.join(__dirname, '..', 'vendor', 'bundled-runtimes', name, version, 'win-x64');
  if (existsSync(src)) {
    sources.push({ src, dest: path.join('wesight-runtime', name, version, 'win-x64') });
  }
}
```

- [ ] **Step 3: Add a new NSIS step to extract `wesight-runtime/` from the tar**

Read `scripts/nsis-installer.nsh` to find the existing tar-extract step
(the one that calls `unpack-cfmind.cjs`). After that step, add a new
`nsExec::ExecToLog` that invokes a new `scripts/unpack-wesight-runtime.cjs`
helper. The new helper:

- Reads `<install dir>\resources\win-resources.tar` (the existing tar).
- Extracts every path under `wesight-runtime/` from the tar into
  `<install dir>\resources\wesight-runtime\`.
- Uses the `tar` npm package (already a project dependency) for
  cross-platform tar extraction.

The NSIS change is a single `nsExec::ExecToLog 'node unpack-wesight-runtime.cjs "$INSTDIR"'` line.

- [ ] **Step 4: Commit**

```bash
git add scripts/electron-builder-hooks.cjs scripts/nsis-installer.nsh scripts/unpack-wesight-runtime.cjs
git commit -m "feat(build): include wesight-runtime in Windows installer tar"
```

---

## Task 14: Update `notarize.js` to add the `--deep` re-sign step

**Files:**
- Modify: `scripts/notarize.js`

- [ ] **Step 1: Read the current `notarize.js`**

Run: `cat scripts/notarize.js`

- [ ] **Step 2: Add the `codesign --force --deep` step before `notarize`**

```js
const { execFileSync } = require('child_process');

function deepSignApp(appPath) {
  console.log(`[notarize] codesign --force --deep --sign ${process.env.APP_IDENTITY || 'Developer ID Application: <id>'} ${appPath}`);
  execFileSync('codesign', [
    '--force', '--deep',
    '--sign', process.env.APP_IDENTITY || 'Developer ID Application: <id>',
    appPath,
  ], { stdio: 'inherit' });
}
```

Call `deepSignApp(appPath)` immediately before the existing `notarize({ appPath })` call.

- [ ] **Step 3: Commit**

```bash
git add scripts/notarize.js
git commit -m "feat(build): add codesign --deep re-sign before notarize"
```

---

## Task 15: Add macOS quarantine stripping + Windows Defender exclusion

**Files:**
- Create: `src/main/runtimeHealth.ts` (macOS quarantine stripper)
- Modify: `scripts/nsis-installer.nsh` (Defender exclusion)

- [ ] **Step 1: Create `src/main/runtimeHealth.ts`**

```ts
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { RuntimeResolver } from './runtimeResolver';

export function stripQuarantineIfNeeded(resourcesPath: string): void {
  if (process.platform !== 'darwin') return;
  const runtimeRoot = path.join(resourcesPath, 'wesight-runtime');
  if (!fs.existsSync(runtimeRoot)) return;

  // Check if any bundled binary has the quarantine xattr.
  const probe = spawnSync('xattr', ['-lr', runtimeRoot], { encoding: 'utf-8' });
  if (probe.status !== 0) return;
  if (!probe.stdout.includes('com.apple.quarantine')) return;

  console.log('[RuntimeHealth] clearing com.apple.quarantine on bundled runtimes');
  const r = spawnSync('xattr', ['-cr', runtimeRoot], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[RuntimeHealth] xattr -cr returned non-zero; some binaries may still be quarantined');
  }
}
```

- [ ] **Step 2: Wire the stripper in main.ts**

In `main.ts`, after `const runtimeResolver = new RuntimeResolver(...)`:

```ts
import { stripQuarantineIfNeeded } from './runtimeHealth';
stripQuarantineIfNeeded(process.resourcesPath);
```

- [ ] **Step 3: Add the Windows Defender exclusion to NSIS**

In `scripts/nsis-installer.nsh`, find the existing `!ifdef WESIGHT_ENABLE_DEFENDER_EXCLUSION` block. Add a second `Add-MpPreference -ExclusionPath` line:

```nsh
nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath ''$INSTDIR\resources\wesight-runtime''"'
Pop $0
```

- [ ] **Step 4: Add unit test for the quarantine stripper**

In `src/main/runtimeHealth.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { stripQuarantineIfNeeded } from './runtimeHealth';

describe('stripQuarantineIfNeeded', () => {
  test('is a no-op on non-darwin platforms', () => {
    if (process.platform === 'darwin') return; // skip on darwin
    expect(() => stripQuarantineIfNeeded('/nonexistent')).not.toThrow();
  });
});
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npx tsc --project electron-tsconfig.json --noEmit && npx vitest run src/main/runtimeHealth.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/runtimeHealth.ts src/main/main.ts src/main/runtimeHealth.test.ts scripts/nsis-installer.nsh
git commit -m "feat(runtime): add macOS quarantine stripper and Windows Defender exclusion"
```

---

## Task 16: OpenClaw migration — update 14+ files to use `vendor/bundled-runtimes/openclaw/<ver>/`

**Files (all modify the path roots):**
- `scripts/openclaw-runtime-host.cjs`
- `scripts/sync-openclaw-runtime-current.cjs`
- `scripts/sync-local-openclaw-extensions.cjs`
- `scripts/bundle-openclaw-gateway.cjs`
- `scripts/ensure-openclaw-plugins.cjs`
- `scripts/precompile-openclaw-extensions.cjs`
- `scripts/prune-openclaw-runtime.cjs`
- `scripts/pack-openclaw-tar.cjs`
- `scripts/build-openclaw-runtime.sh`
- `package.json` (6 `openclaw:runtime:<target>` scripts)
- `src/main/libs/openclawConfigSync.ts` (lines 312-316)
- `src/main/libs/openclawLocalExtensions.ts` (lines 33-37)

- [ ] **Step 1: For each script, replace `vendor/openclaw-runtime` with `vendor/bundled-runtimes/openclaw/<ver>`**

The new path is computed from the manifest's `openclaw.version`. Add a helper at the top of each script:

```js
const OPENCLAW_VERSION = (() => {
  const pkg = require(path.resolve(__dirname, '..', 'package.json'));
  return pkg.runtimeManifest.openclaw.version;
})();
const NEW_OPENCLAW_ROOT = path.resolve(__dirname, '..', 'vendor', 'bundled-runtimes', 'openclaw', OPENCLAW_VERSION);
```

Then replace all `vendor/openclaw-runtime` references with `NEW_OPENCLAW_ROOT`. The `<target>` slice is still `<target>` (e.g. `mac-arm64`).

- [ ] **Step 2: Update `src/main/libs/openclawConfigSync.ts` (lines 312-316)**

The packaged-build path is `process.resourcesPath/cfmind` (this is the Windows tar unpack target — keep it). The dev-mode fallback paths change from `vendor/openclaw-runtime/current` to `vendor/bundled-runtimes/openclaw/<ver>/current`:

```ts
const OPENCLAW_VERSION = (() => {
  // lazy: package.json read in main process
  // (this file is a main-process file, so require is safe)
  const pkg = require('../../../package.json');
  return pkg.runtimeManifest.openclaw.version;
})();

// ...
const runtimeRoots = app.isPackaged === true
  ? [path.join(process.resourcesPath, 'cfmind')]
  : [
      path.join(app.getAppPath(), 'vendor', 'bundled-runtimes', 'openclaw', OPENCLAW_VERSION, 'current'),
      path.join(process.cwd(), 'vendor', 'bundled-runtimes', 'openclaw', OPENCLAW_VERSION, 'current'),
    ];
```

- [ ] **Step 3: Update `src/main/libs/openclawLocalExtensions.ts` (lines 33-37)**

Same pattern as the previous step for the `cfmind/extensions` packaged path and the dev-mode `vendor/bundled-runtimes/openclaw/<ver>/current/extensions` fallback.

- [ ] **Step 4: Update the 6 `openclaw:runtime:<target>` npm scripts in `package.json`**

The per-target scripts currently call `scripts/run-build-openclaw-runtime.cjs <target>` and `scripts/sync-openclaw-runtime-current.cjs <target>`. These sub-scripts need updating to write into `vendor/bundled-runtimes/openclaw/<ver>/<target>/` and copy/symlink `current/` from there. Update `scripts/run-build-openclaw-runtime.cjs` and `scripts/sync-openclaw-runtime-current.cjs` first, then the npm scripts just inherit the change.

- [ ] **Step 5: Run typecheck and tests**

Run: `npx tsc --project electron-tsconfig.json --noEmit && npx vitest run`
Expected: clean typecheck; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/ src/main/libs/ package.json
git commit -m "refactor(openclaw): migrate runtime root to vendor/bundled-runtimes namespace"
```

---

## Task 17: Add lint rules to enforce the resolver boundary

**Files:**
- Modify: `eslint.config.js` (or `.eslintrc.json`)

- [ ] **Step 1: Read the current eslint config**

Run: `cat eslint.config.js 2>&1 | head -50 || cat .eslintrc.json 2>&1 | head -50`

- [ ] **Step 2: Add `no-restricted-syntax` rules**

```js
{
  files: ['src/main/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value=/vendor\\/bundled-runtimes/]",
        message: 'Do not hardcode paths under vendor/bundled-runtimes. Use RuntimeResolver instead.',
      },
      {
        selector: "TemplateElement[value.raw=/vendor\\/bundled-runtimes/]",
        message: 'Do not hardcode paths under vendor/bundled-runtimes. Use RuntimeResolver instead.',
      },
    ],
  },
}
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: clean (or only pre-existing warnings).

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore(lint): forbid vendor/bundled-runtimes in src/main"
```

---

## Task 18: Update Vite config to expose `WESIGHT_BUNDLED_RUNTIMES_AVAILABLE`

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Read the `define` block in `vite.config.ts`**

Run: `grep -A 10 "define:" vite.config.ts`

- [ ] **Step 2: Add the bundled-runtimes flag to the `define` block**

```ts
define: {
  // ...
  'import.meta.env.WESIGHT_BUNDLED_RUNTIMES_AVAILABLE': JSON.stringify(true),
},
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat(runtime): expose WESIGHT_BUNDLED_RUNTIMES_AVAILABLE flag to renderer"
```

---

## Task 19: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read the current `.gitignore`**

Run: `grep -n "vendor" .gitignore`

- [ ] **Step 2: Add the new ignore**

```
vendor/bundled-runtimes/
```

Remove the now-stale `vendor/hermes-runtime/` line if it exists.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(git): ignore vendor/bundled-runtimes and drop stale hermes line"
```

---

## Task 20: Update `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Read the existing `AGENTS.md` "Build and Development Commands" section**

Run: `grep -n "## Build and Development Commands\|## Architecture Overview" AGENTS.md`

- [ ] **Step 2: Add `setup-bundled-runtimes` to the build commands table**

Insert into the existing `## Build and Development Commands` table:

```
| `npm run setup-bundled-runtimes` | CI/local: download 8 runtimes (node, python, git, gh, claudecode, codex, hermes, openclaw) into `vendor/bundled-runtimes/<name>/<ver>/<target>/` with SHA-256 verification |
```

- [ ] **Step 3: Insert a new "Bundled Runtimes" section after "Build and Development Commands" and before "Architecture Overview"**

```markdown
## Bundled Runtimes

WeSight's installer carries 8 runtimes so end users do not need to install
any host-level dependencies. The versions are pinned in
`package.json:runtimeManifest`.

| Runtime | Source | Version |
| --- | --- | --- |
| node | nodejs.org | see `runtimeManifest.node.version` |
| python | python.org | see `runtimeManifest.python.version` |
| git | git-scm.com / MinGit | see `runtimeManifest.git.version` |
| gh | github.com/cli/cli | see `runtimeManifest.gh.version` |
| claudecode | npm `@anthropic-ai/claude-code` | see `runtimeManifest.claudecode.version` |
| codex | npm `@openai/codex` | see `runtimeManifest.codex.version` |
| hermes | github.com/NousResearch/hermes-agent | see `runtimeManifest.hermes.version` |
| openclaw | existing `openclaw:runtime:<target>` flow | see `runtimeManifest.openclaw.version` |

To upgrade a runtime, bump the version in `runtimeManifest` and re-run
`npm run setup-bundled-runtimes` to refresh the SHA-256. A WeSight
release ships the new `vendor/bundled-runtimes/` tree.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document bundled runtimes in AGENTS.md"
```

---

## Task 21: End-to-end smoke test (full CI build)

**Files:** none modified

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: 495+ tests pass (487 prior + 8 new in Tasks 1, 2, 15).

- [ ] **Step 2: Run the full typecheck**

Run: `npx tsc --project electron-tsconfig.json --noEmit && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Run the full mac-arm64 build on a CI runner**

Run: `npm run dist:mac:arm64`
Expected: `release/WeSight-<ver>-mac-arm64.dmg` (1.5-1.8 GB).

- [ ] **Step 5: Run the full Windows build on a CI runner**

Run: `npm run dist:win`
Expected: `release/WeSight-<ver>-win-x64.exe` (1.2-1.3 GB).

- [ ] **Step 6: Run the full Linux build on a CI runner**

Run: `npm run dist:linux`
Expected: `release/WeSight-<ver>-linux-x64.AppImage` (1.0-1.1 GB).

- [ ] **Step 7: On a clean Mac, install the DMG and verify**

- [ ] `find /Applications/WeSight.app/Contents/Resources/wesight-runtime -name '<binary>'` returns all 8 expected binaries
- [ ] Launch WeSight; DevTools console: `await window.electron.runtime.getHealth()` returns 8 hits
- [ ] Settings → Engine → Claude Code → "Test" passes
- [ ] Start a cowork session with ClaudeCode engine; verify it streams back successfully
- [ ] Repeat for CodeX, Hermes, OpenClaw engines

- [ ] **Step 8: Final sign-off**

Update the spec file with a `## Implementation Status` footer and commit.
