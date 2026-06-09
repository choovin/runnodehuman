'use strict';

const fs = require('fs');
const path = require('path');

function syncLocalOpenClawExtensions(runtimeRoot) {
  const rootDir = path.resolve(__dirname, '..');
  const sourceDir = path.join(rootDir, 'openclaw-extensions');
  let targetRoot;
  if (runtimeRoot) {
    targetRoot = path.resolve(runtimeRoot);
  } else if (process.env.OPENCLAW_RUNTIME_DIR) {
    targetRoot = path.resolve(process.env.OPENCLAW_RUNTIME_DIR);
  } else {
    // Bundled-runtimes namespace (post-Task-16) or legacy fallback.
    let bundledDefault = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
      const v = pkg.runtimeManifest?.openclaw?.version;
      if (v) bundledDefault = path.join(rootDir, 'vendor', 'bundled-runtimes', 'openclaw', v, 'current');
    } catch {}
    const legacyDefault = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');
    targetRoot = bundledDefault && fs.existsSync(bundledDefault) ? bundledDefault : legacyDefault;
  }
  const targetExtensionsDir = path.join(targetRoot, 'extensions');

  if (!fs.existsSync(sourceDir)) {
    return { sourceDir, targetRoot, copied: [] };
  }
  if (!fs.existsSync(targetExtensionsDir)) {
    throw new Error(`Runtime extensions directory does not exist: ${targetExtensionsDir}`);
  }

  const copied = [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetExtensionsDir, entry.name);
    fs.cpSync(src, dest, { recursive: true, force: true });
    copied.push(entry.name);
  }

  return { sourceDir, targetRoot, copied };
}

function main() {
  try {
    const runtimeRoot = (process.argv[2] || '').trim() || undefined;
    const result = syncLocalOpenClawExtensions(runtimeRoot);
    if (result.copied.length === 0) {
      console.log('[sync-local-openclaw-extensions] No local extensions to sync.');
      return;
    }
    console.log(
      `[sync-local-openclaw-extensions] Synced ${result.copied.join(', ')} -> ${path.join(result.targetRoot, 'extensions')}`,
    );
  } catch (error) {
    console.error(
      `[sync-local-openclaw-extensions] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  syncLocalOpenClawExtensions,
};
