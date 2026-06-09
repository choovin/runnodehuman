import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { RuntimeName } from '../shared/runtime/constants';
import type { RuntimeManifest } from '../shared/runtime/manifest';

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

const TEST_MANIFEST: RuntimeManifest = {
  node: { version: '22.11.0', sha256: 'a'.repeat(64) },
  python: { version: '3.12.7', sha256: 'b'.repeat(64) },
  git: { version: '2.47.1', sha256: 'c'.repeat(64) },
  gh: { version: '2.65.0', sha256: 'd'.repeat(64) },
  claudecode: { version: '1.0.0', sha256: 'e'.repeat(64) },
  codex: { version: '0.1.0', sha256: 'f'.repeat(64) },
  hermes: { version: '2026.4.1', sha256: '1'.repeat(64) },
  openclaw: { version: 'v2026.3.2', sha256: '2'.repeat(64) },
};

describe('RuntimeResolver', () => {
  test('tryGetPath returns the absolute path for a present binary', async () => {
    const binPath = writeBinary('wesight-runtime/node/22.11.0/darwin-arm64/bin/node');
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    expect(resolver.tryGetPath('node')).toBe(binPath);
  });

  test('tryGetPath returns null when the binary is missing', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    expect(resolver.tryGetPath('node')).toBeNull();
  });

  test('tryGetPath never throws on any RuntimeName', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    for (const name of Object.values(RuntimeName)) {
      expect(() => resolver.tryGetPath(name)).not.toThrow();
      expect(resolver.tryGetPath(name)).toBeNull();
    }
  });

  test('tryGetAll returns 8 entries (one per RuntimeName), all null when nothing is present', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    const all = resolver.tryGetAll();
    expect(all.size).toBe(8);
    for (const name of Object.values(RuntimeName)) {
      expect(all.get(name)).toBeNull();
    }
  });

  test('tryGetAll populates a non-null entry with path + version when the binary is present', async () => {
    writeBinary('wesight-runtime/node/22.11.0/darwin-arm64/bin/node');
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    const all = resolver.tryGetAll();
    const node = all.get('node');
    expect(node).not.toBeNull();
    expect(node!.path).toContain('node/22.11.0/darwin-arm64/bin/node');
    expect(node!.version).toBe('22.11.0');
    expect(node!.source).toBe('bundled');
  });

  test('buildPath("claudecode") includes the bundled node bin dir', async () => {
    writeBinary('wesight-runtime/claudecode/1.0.0/darwin-arm64/bin/claude');
    writeBinary('wesight-runtime/node/22.11.0/darwin-arm64/bin/node');
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    const pathFragment = resolver.buildPath('claudecode');
    expect(pathFragment).toContain('node/22.11.0/darwin-arm64/bin');
    expect(pathFragment).toContain('claudecode/1.0.0/darwin-arm64/bin');
  });

  test('getHealth returns a map keyed by RuntimeName', async () => {
    const { RuntimeResolver } = await import('./runtimeResolver');
    const resolver = new RuntimeResolver(tmpRoot, TEST_MANIFEST);
    const health = resolver.getHealth();
    expect(health.size).toBe(8);
  });
});

