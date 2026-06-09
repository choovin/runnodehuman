const { test } = require('node:test');
const assert = require('node:assert');

test('parseManifest throws on a missing runtime', () => {
  const { parseManifest } = require('./setup-bundled-runtimes.cjs');
  assert.throws(
    () => parseManifest({ node: { version: '1', sha256: 'a'.repeat(64) } }),
    /missing/
  );
});

test('parseManifest throws on an invalid sha256', () => {
  const { parseManifest } = require('./setup-bundled-runtimes.cjs');
  assert.throws(
    () => parseManifest({ node: { version: '1', sha256: 'short' } }),
    /sha256/
  );
});

test('parseManifest accepts a valid manifest', () => {
  const { parseManifest } = require('./setup-bundled-runtimes.cjs');
  const m = {
    node: { version: '22.11.0', sha256: 'a'.repeat(64) },
    python: { version: '3.12.7', sha256: 'b'.repeat(64) },
    git: { version: '2.47.1', sha256: 'c'.repeat(64) },
    gh: { version: '2.65.0', sha256: 'd'.repeat(64) },
    claudecode: { version: '1.0.0', sha256: 'e'.repeat(64) },
    codex: { version: '0.1.0', sha256: 'f'.repeat(64) },
    hermes: { version: '2026.4.1', sha256: '1'.repeat(64) },
    openclaw: { version: 'v2026.3.2', sha256: '2'.repeat(64) },
  };
  const r = parseManifest(m);
  assert.strictEqual(r.node.version, '22.11.0');
});
