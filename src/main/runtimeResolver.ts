import path from 'path';
import fs from 'fs';
import type { RuntimeManifest } from '../shared/runtime/manifest';
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

const RUNTIME_BINARY_WIN32: Record<RuntimeName, string> = {
  node: 'node.exe',
  python: 'python.exe',
  git: 'bin/git.exe',
  gh: 'bin/gh.exe',
  claudecode: 'claude.cmd',
  codex: 'codex.cmd',
  hermes: 'hermes.exe',
  openclaw: 'openclaw.mjs',
};

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
    const m = this.getManifest();
    const version = m[name]?.version ?? '';
    return path.join(this.resourcesPath, 'wesight-runtime', name, version, this.slice());
  }

  private binaryFor(name: RuntimeName): string {
    return process.platform === 'win32' ? RUNTIME_BINARY_WIN32[name] : RUNTIME_BINARY[name];
  }

  tryGetPath(name: RuntimeName): string | null {
    const fullPath = path.join(this.rootFor(name), this.binaryFor(name));
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

