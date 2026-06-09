import fs from 'fs';
import path from 'path';

import { RuntimeName } from '../shared/runtime/constants';
import type { RuntimeManifest } from '../shared/runtime/manifest';

const RUNTIME_BINARY: Record<RuntimeName, string> = {
  node: 'bin/node',
  python: 'bin/python3',
  git: 'bin/git',
  gh: 'bin/gh',
  // Claude Code and Codex are npm-packaged JS CLI tools. The npm
  // package.json declares `bin: { claude: 'cli.js' }` / `bin: { codex:
  // 'bin/codex.js' }` but does not actually install a shebang wrapper at
  // `bin/claude` or `bin/codex`. We record the JS entry point here;
  // callers that need to spawn these runtimes should use
  // `tryGetSpawnSpec(name)` to get a `{ command, args }` pair that
  // invokes the entry through the bundled `node` binary.
  claudecode: 'cli.js',
  codex: 'bin/codex.js',
  hermes: 'bin/hermes',
  openclaw: 'openclaw.mjs',
};

const RUNTIME_BINARY_WIN32: Record<RuntimeName, string> = {
  node: 'node.exe',
  python: 'python.exe',
  git: 'bin/git.exe',
  gh: 'bin/gh.exe',
  // On Windows, the npm-installed shim is `<id>.cmd` (created when
  // `npm install` runs in a parent that has node on PATH). The
  // .cmd is not part of the package itself; consumers that need to
  // invoke claudecode/codex on Windows should resolve the underlying
  // JS entry via the same `tryGetSpawnSpec` path.
  claudecode: 'cli.js',
  codex: 'bin/codex.js',
  hermes: 'hermes.exe',
  openclaw: 'openclaw.mjs',
};

// Some runtimes ship as JS modules rather than compiled binaries, so
// they need to be invoked through the bundled Node binary instead of
// being spawned directly. Listed by name; consumers use
// `tryGetSpawnSpec` to construct the right spawn command.
const NODE_SCRIPT_RUNTIMES = new Set<RuntimeName>(['claudecode', 'codex']);

export interface ResolvedRuntime {
  name: RuntimeName;
  path: string;
  version: string;
  source: 'bundled';
}

export type ResolvedRuntimeMap = Map<RuntimeName, ResolvedRuntime | null>;

export class RuntimeResolver {
  private cachedManifest: RuntimeManifest | null = null;

  constructor(
    private readonly resourcesPath: string,
    private readonly manifest: RuntimeManifest | null = null
  ) {}

  private getManifest(): RuntimeManifest {
    if (this.manifest) return this.manifest;
    if (this.cachedManifest) return this.cachedManifest;
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.runtimeManifest) {
        this.cachedManifest = pkg.runtimeManifest as RuntimeManifest;
        return this.cachedManifest;
      }
    } catch {
      // ignore
    }
    return {} as RuntimeManifest;
  }

  private slice(): string {
    // Match the slice naming used by electron-builder's
    // `resolveOpenClawRuntimeTargetId` helper and by setup-bundled-runtimes
    // (mac-arm64, mac-x64, win-arm64, win-x64, linux-arm64, linux-x64).
    // These are the directory names under
    // Resources/wesight-runtime/<name>/<version>/ after the extraResources
    // copy. Using the legacy `darwin-arm64` / `win32-x64` shape here would
    // point at non-existent directories and silently disable bundled
    // runtimes.
    const platform =
      process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'win'
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
    const m = this.getManifest();
    const version = m[name]?.version ?? '';
    return path.join(this.resourcesPath, 'wesight-runtime', name, version, this.slice());
  }

  private binaryFor(name: RuntimeName): string {
    return process.platform === 'win32' ? RUNTIME_BINARY_WIN32[name] : RUNTIME_BINARY[name];
  }

  tryGetPath(name: RuntimeName): string | null {
    // JS-only runtimes (claudecode, codex) cannot be spawned directly;
    // callers should use `tryGetSpawnSpec` to get a `{ command, args }`
    // pair that invokes them through the bundled Node binary.
    if (NODE_SCRIPT_RUNTIMES.has(name)) {
      const fullPath = path.join(this.rootFor(name), this.binaryFor(name));
      try {
        fs.accessSync(fullPath, fs.constants.R_OK);
        return fullPath;
      } catch {
        return null;
      }
    }
    const fullPath = path.join(this.rootFor(name), this.binaryFor(name));
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      return null;
    }
  }

  /**
   * Return a spawn spec for the given runtime. For native binaries this is
   * `{ command: <absolute path>, args: [] }`. For JS-only runtimes
   * (claudecode, codex) this is `{ command: <bundled node path>, args:
   * [<entry script>] }`. Returns null if the runtime cannot be resolved.
   *
   * Use this instead of `tryGetPath` whenever the caller intends to spawn
   * the runtime.
   */
  tryGetSpawnSpec(name: RuntimeName): { command: string; args: string[] } | null {
    if (NODE_SCRIPT_RUNTIMES.has(name)) {
      const nodePath = this.tryGetPath('node');
      const entryPath = this.tryGetPath(name);
      if (!nodePath || !entryPath) return null;
      return { command: nodePath, args: [entryPath] };
    }
    const p = this.tryGetPath(name);
    return p === null ? null : { command: p, args: [] };
  }

  tryGetAll(): ResolvedRuntimeMap {
    const map: ResolvedRuntimeMap = new Map();
    for (const name of Object.values(RuntimeName)) {
      const p = this.tryGetPath(name);
      const m = this.getManifest();
      const version = m[name]?.version ?? '';
      map.set(
        name,
        p === null
          ? null
          : { name, path: p, version, source: 'bundled' as const }
      );
    }
    return map;
  }

  buildPath(name: RuntimeName): string {
    const slice = this.slice();
    const parts: string[] = [];
    const ownRoot = this.rootFor(name);
    parts.push(path.join(ownRoot, 'bin'));
    if (name !== RuntimeName.Node) {
      const nodeRoot = this.rootFor(RuntimeName.Node);
      parts.push(path.join(nodeRoot, 'bin'));
    }
    return parts.join(path.delimiter);
  }

  getHealth(): ResolvedRuntimeMap {
    return this.tryGetAll();
  }
}

