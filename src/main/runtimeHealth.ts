import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Strip the macOS com.apple.quarantine xattr from the bundled runtime
 * directory. When an end user downloads WeSight from a browser, the
 * entire .app bundle receives a quarantine xattr; Python 3.12 and Node 22
 * refuse to load .dylib/.node extensions from quarantined trees. We
 * clear the xattr on first launch. The operation is idempotent: if no
 * binaries have the quarantine xattr, this is a no-op.
 *
 * Linux/Windows: no-op (the function returns silently).
 */
export function stripQuarantineIfNeeded(resourcesPath: string): void {
  if (process.platform !== 'darwin') return;
  const runtimeRoot = path.join(resourcesPath, 'wesight-runtime');
  if (!fs.existsSync(runtimeRoot)) return;

  // Probe whether any bundled binary has the quarantine xattr.
  const probe = spawnSync('xattr', ['-lr', runtimeRoot], { encoding: 'utf-8' });
  if (probe.status !== 0) return;
  if (!probe.stdout.includes('com.apple.quarantine')) return;

  console.log('[RuntimeHealth] clearing com.apple.quarantine on bundled runtimes');
  const r = spawnSync('xattr', ['-cr', runtimeRoot], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[RuntimeHealth] xattr -cr returned non-zero; some binaries may still be quarantined');
  }
}
