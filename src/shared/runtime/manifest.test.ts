import { describe, expect, test } from 'vitest';
import { parseRuntimeManifest } from './manifest';

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
