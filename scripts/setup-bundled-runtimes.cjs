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
  for (const name of [
    'node',
    'python',
    'git',
    'gh',
    'claudecode',
    'codex',
    'hermes',
    'openclaw',
  ]) {
    const spec = manifest[name];
    if (!spec || typeof spec !== 'object') throw new Error(`runtimeManifest: missing ${name}`);
    if (typeof spec.version !== 'string' || spec.version.length === 0) {
      throw new Error(`runtimeManifest: missing ${name}.version`);
    }
    if (typeof spec.sha256 !== 'string' || !(SHA256_RE.test(spec.sha256) || spec.sha256 === 'REPLACE_AFTER_FIRST_FETCH')) {
      throw new Error(`runtimeManifest: ${name}.sha256 must be 64 hex chars or "REPLACE_AFTER_FIRST_FETCH"`);
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

async function downloadAndVerify({ name, version, url, destRel, expectedSha256, skipVerify = false }) {
  const destAbs = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', name, version, destRel);
  await downloadTo(url, destAbs);
  if (skipVerify || expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    console.warn(`[downloadAndVerify] ${name}: sha256 placeholder detected, skipping verify; will write back actual hash`);
    return { destAbs, actualSha256: sha256OfFile(destAbs) };
  }
  const actual = sha256OfFile(destAbs);
  if (actual !== expectedSha256) {
    fs.rmSync(destAbs, { force: true });
    throw new Error(`${name}: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  return { destAbs, actualSha256: actual };
}

function writeManifestSlice(name, version, slice, files) {
  const sliceRoot = path.join(vendorDir(name, version), slice);
  fs.mkdirSync(sliceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sliceRoot, 'slice.json'),
    JSON.stringify({ name, version, slice, files }, null, 2)
  );
}

// Write a real sha256 back into package.json:runtimeManifest.<name>.sha256.
// Used the first time setup-bundled-runtimes runs against a placeholder
// manifest. We use targeted string replacement (not full-file JSON
// re-serialization) to avoid touching unrelated fields and minimize the
// resulting diff.
function writeBackRuntimeSha256(name, slice, actualSha256) {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  // Match the line for this runtime in the runtimeManifest block, replacing
  // only the sha256 field. Tolerates surrounding whitespace; relies on
  // JSON.stringify-without-space formatting (matches the project's style).
  const pattern = new RegExp(
    `("${name}"\\s*:\\s*\\{\\s*"version"\\s*:\\s*"[^"]*"\\s*,\\s*"sha256"\\s*:\\s*)"[^"]*"`
  );
  if (!pattern.test(raw)) {
    console.warn(`[writeBackRuntimeSha256] ${name}: pattern not found in package.json, skipping`);
    return;
  }
  const updated = raw.replace(pattern, `$1"${actualSha256}"`);
  fs.writeFileSync(pkgPath, updated);
  console.log(`[writeBackRuntimeSha256] ${name} (${slice}): wrote sha256 ${actualSha256.slice(0, 12)}...`);
}

// Per-runtime fetch functions. Each one downloads the official artifact
// from upstream, verifies SHA-256, and extracts into the slice directory.
// The actual URLs and extraction steps are filled in by the first CI run
// when real upstream artifacts are downloaded.
//
// Implementation pattern (see Task 9 for fetchNode):
//   1. Pick the right upstream URL per (platform, arch).
//   2. Call downloadAndVerify(...) to fetch + verify.
//   3. Extract into vendor/bundled-runtimes/<name>/<version>/<platform>-<arch>/
//      using the `tar` npm package (cross-platform).
//   4. fs.rmSync the downloaded archive.

async function fetchNode(version, slice, expectedSha256) {
  const NODE_BASE = 'https://nodejs.org/dist';
  const [platform, arch] = slice.split('-');
  let url, archiveExt;
  if (platform === 'darwin' || platform === 'mac') {
    // Upstream nodejs.org uses `darwin` in the URL but the slice namespace
    // we use is `mac-*` (matching electron-builder's resolveOpenClawRuntimeTargetId).
    url = `${NODE_BASE}/v${version}/node-v${version}-darwin-${arch}.tar.xz`;
    archiveExt = 'tar.xz';
  } else if (platform === 'linux') {
    url = `${NODE_BASE}/v${version}/node-v${version}-linux-${arch}.tar.xz`;
    archiveExt = 'tar.xz';
  } else if (platform === 'win' || platform === 'win32') {
    url = `${NODE_BASE}/v${version}/node-v${version}-win-x64.7z`;
    archiveExt = '7z';
  }
  if (!url) throw new Error(`unsupported node slice: ${slice}`);
  const ext = archiveExt.split('.').pop();
  const destRel = `node-v${version}-${platform}-${arch}.${ext}`;
  const { destAbs, actualSha256 } = await downloadAndVerify({
    name: 'node',
    version,
    url,
    destRel,
    expectedSha256,
  });
  if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    writeBackRuntimeSha256('node', slice, actualSha256);
  }
  const extractRoot = path.join(vendorDir('node', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  if (archiveExt === 'tar.xz') {
    // The `tar` npm package does not support .xz natively on Node 24; we
    // shell out to `xz -dc` and pipe into `tar x` (libarchive-free, fast).
    // On macOS, `xz` ships with the OS via Command Line Tools or Homebrew.
    const tar = require('tar');
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const xz = spawn('xz', ['-dc']);
      const t = tar.x({ cwd: extractRoot, strip: 1 });
      xz.stdout.pipe(t);
      xz.on('error', reject);
      t.on('end', resolve);
      t.on('error', reject);
      const input = fs.createReadStream(destAbs);
      input.on('error', reject);
      input.pipe(xz.stdin);
    });
  } else {
    // .7z extraction on Windows: defer to follow-up; tar package does not
    // support .7z either. Real Win builds use 7zip.
    throw new Error(`node: ${archiveExt} extraction not yet implemented`);
  }
  fs.rmSync(destAbs);
}
async function fetchPython(version, slice, expectedSha256) {
  // Upstream: https://www.python.org/ftp/python/<v>/
  //   mac:    python-<v>-macos11.pkg (or build from source on aarch64)
  //   linux:  Python-<v>.tar.xz (build from source)
  //   win32:  python-<v>-embed-amd64.zip
  //
  // For the macOS .pkg, the extraction step is non-trivial (xar then cpio).
  // For the linux tar.xz, configure + make is too slow for CI. We recommend
  // using the Win32 embeddable zip for Windows and deferring the macOS/Linux
  // build to a follow-up; until then, macOS and Linux fall through to the
  // existing setup:python-runtime / system python fallback.
  if (slice.startsWith('win') || slice.startsWith('win32')) {
    const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
    const destRel = `python-${version}-embed-amd64.zip`;
    const { destAbs, actualSha256 } = await downloadAndVerify({ name: 'python', version, url, destRel, expectedSha256 });
    if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
      writeBackRuntimeSha256('python', slice, actualSha256);
    }
    const extractRoot = path.join(vendorDir('python', version), slice);
    fs.mkdirSync(extractRoot, { recursive: true });
    // Python embeddable zip has no top-level directory; extract in place.
    const { execFileSync } = require('child_process');
    execFileSync('unzip', ['-q', destAbs, '-d', extractRoot], { stdio: 'inherit' });
    fs.rmSync(destAbs);
    return;
  }
  console.warn(`[fetchPython] no upstream available for ${slice}; skipping (host python will be used)`);
}

async function fetchGit(version, slice, expectedSha256) {
  // Upstream options:
  //   mac:    https://git-scm.com/download/mac (installer pkg, not a portable tar)
  //   linux:  use system git; no fetch.
  //   win32:  https://github.com/git-for-windows/git/releases/download/v<ver>/MinGit-<ver>-64-bit.zip
  //
  // Until the macOS .pkg extraction is wired, macOS falls through to
  // system git (Xcode Command Line Tools' git). Linux likewise.
  if (slice.startsWith('win') || slice.startsWith('win32')) {
    const url = `https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/MinGit-${version}-64-bit.zip`;
    const destRel = `MinGit-${version}-64-bit.zip`;
    const { destAbs, actualSha256 } = await downloadAndVerify({ name: 'git', version, url, destRel, expectedSha256 });
    if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
      writeBackRuntimeSha256('git', slice, actualSha256);
    }
    const extractRoot = path.join(vendorDir('git', version), slice);
    fs.mkdirSync(extractRoot, { recursive: true });
    const { execFileSync } = require('child_process');
    execFileSync('unzip', ['-q', destAbs, '-d', extractRoot], { stdio: 'inherit' });
    fs.rmSync(destAbs);
    return;
  }
  console.warn(`[fetchGit] no portable upstream for ${slice}; using system git`);
}

async function fetchGh(version, slice, expectedSha256) {
  // Upstream: https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_<os>_<arch>.zip
  //
  // As of gh 2.65.0, all official assets are .zip (no more .tar.gz).
  // Asset names: gh_2.65.0_macOS_arm64.zip, gh_2.65.0_linux_amd64.zip,
  //              gh_2.65.0_windows_amd64.zip
  const tar = require('tar');
  const [platform, arch] = slice.split('-');
  const platformSlug =
    platform === 'darwin' || platform === 'mac' ? 'macOS'
      : platform === 'win' || platform === 'win32' ? 'windows' : 'linux';
  const archSlug = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : 'amd64';
  const ext = 'zip';
  const url = `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_${platformSlug}_${archSlug}.${ext}`;
  const destRel = `gh_${version}_${platformSlug}_${archSlug}.${ext}`;
  const { destAbs, actualSha256 } = await downloadAndVerify({ name: 'gh', version, url, destRel, expectedSha256 });
  if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    writeBackRuntimeSha256('gh', slice, actualSha256);
  }
  const extractRoot = path.join(vendorDir('gh', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  // The `tar` npm package does not support .zip; unzip to a temp dir, then
  // move the top-level entry's contents up to the extract root.
  const { execFileSync } = require('child_process');
  const tmpRoot = path.join(vendorDir('gh', version), `${slice}.tmp`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  execFileSync('unzip', ['-q', destAbs, '-d', tmpRoot], { stdio: 'inherit' });
  // The archive has a single top-level dir (e.g. gh_2.65.0_macOS_arm64/);
  // move its children up to extractRoot using cp+rm because macOS `mv`
  // requires the destination directory to exist.
  const topLevel = fs.readdirSync(tmpRoot);
  if (topLevel.length === 1) {
    const inner = path.join(tmpRoot, topLevel[0]);
    execFileSync('cp', ['-R', inner + '/', extractRoot + '/'], { stdio: 'inherit' });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    // Multiple top-level entries; just rename the tmp dir.
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.renameSync(tmpRoot, extractRoot);
  }
  fs.rmSync(destAbs);
}

async function fetchClaudeCode(version, slice, expectedSha256) {
  // Upstream: npm registry, package @anthropic-ai/claude-code
  //   npm pack @anthropic-ai/claude-code@<version> --pack-destination <tmp>
  //   tar -xf <packed>.tgz
  // `npm pack` writes the tarball with the package's full name (including
  // scope), so we glob to find it instead of hardcoding the filename.
  const tar = require('tar');
  const { execFileSync } = require('child_process');
  const tmpDir = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', 'claudecode', version, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('npm', ['pack', `@anthropic-ai/claude-code@${version}`, '--pack-destination', tmpDir], {
    stdio: 'inherit',
  });
  const packedTar = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f)).find((p) => p.endsWith('.tgz'));
  if (!packedTar) throw new Error('claudecode: npm pack produced no .tgz');
  const extractRoot = path.join(vendorDir('claudecode', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({ file: packedTar, cwd: extractRoot, strip: 1 });
  // Verify SHA-256 of the tarball for the manifest record. If the manifest
  // is a placeholder, skip verification but still write back the actual hash.
  const actual = sha256OfFile(packedTar);
  if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    writeBackRuntimeSha256('claudecode', slice, actual);
  } else if (actual !== expectedSha256) {
    throw new Error(`claudecode: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  fs.rmSync(packedTar, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function fetchCodex(version, slice, expectedSha256) {
  // Upstream: npm registry, package @openai/codex
  const tar = require('tar');
  const { execFileSync } = require('child_process');
  const tmpDir = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', 'codex', version, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('npm', ['pack', `@openai/codex@${version}`, '--pack-destination', tmpDir], {
    stdio: 'inherit',
  });
  const packedTar = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f)).find((p) => p.endsWith('.tgz'));
  if (!packedTar) throw new Error('codex: npm pack produced no .tgz');
  const extractRoot = path.join(vendorDir('codex', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({ file: packedTar, cwd: extractRoot, strip: 1 });
  const actual = sha256OfFile(packedTar);
  if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    writeBackRuntimeSha256('codex', slice, actual);
  } else if (actual !== expectedSha256) {
    throw new Error(`codex: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  fs.rmSync(packedTar, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function fetchHermes(version, slice, expectedSha256) {
  // Hermes Agent (https://github.com/NousResearch/hermes-agent) is a
  // Python package distributed via PyPI, not a binary release on GitHub.
  // Bundling it as a standalone runtime would require installing it into
  // a vendor venv (pip install --target <dir>), which is a significantly
  // different shape from the other 7 runtimes.
  //
  // For now, skip on all platforms and fall back to system python + pip
  // install. The runtime resolver returns null for `hermes` in this
  // configuration, and the relevant code paths use system hermes.
  // TODO(B-future): implement venv-based bundling.
  console.warn(`[fetchHermes] hermes-agent is a Python package; skipping runtime bundle (will use system hermes)`);
}

async function fetchOpenClaw(version, slice, expectedSha256) {
  // Adopt the RClaw install pattern: source from the official `openclaw` npm
  // package (which is a pre-built, self-contained distribution), install
  // production-only dependencies, and lay out under the same
  // `vendor/bundled-runtimes/openclaw/<version>/<slice>/` namespace the
  // git-clone path used to fill. This keeps the resolver and downstream
  // consumers agnostic to which source we used.
  //
  // The legacy git-clone + build chain is preserved as the
  // `openclaw:runtime:<target>` npm scripts (used for dev-mode and for
  // applying the WeSight-specific patches under scripts/patches/<version>/).
  const tar = require('tar');
  const { execFileSync } = require('child_process');
  const sliceRoot = path.join(vendorDir('openclaw', version), slice);
  const tmpDir = path.join(vendorDir('openclaw', version), '.npm-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. npm pack
  console.log(`[fetchOpenClaw] npm pack openclaw@${version} -> ${tmpDir}`);
  execFileSync('npm', ['pack', `openclaw@${version}`, '--pack-destination', tmpDir], {
    stdio: 'inherit',
  });
  const packedTar = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f)).find((p) => p.endsWith('.tgz'));
  if (!packedTar) throw new Error('[fetchOpenClaw] npm pack produced no .tgz');

  // 2. Compute sha256 of the tarball for the manifest record
  const actual = sha256OfFile(packedTar);
  if (expectedSha256 === 'REPLACE_AFTER_FIRST_FETCH') {
    writeBackRuntimeSha256('openclaw', slice, actual);
  } else if (actual !== expectedSha256) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`openclaw: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }

  // 3. Extract into the slice root
  fs.rmSync(sliceRoot, { recursive: true, force: true });
  fs.mkdirSync(sliceRoot, { recursive: true });
  await tar.x({ file: packedTar, cwd: sliceRoot, strip: 1 });

  // 4. Install production-only dependencies (matches RClaw's pattern of
  //    using a pre-built distribution; RClaw uses pnpm but npm install here
  //    is functionally equivalent and avoids the pnpm symlink-store
  //    complications).
  console.log(`[fetchOpenClaw] installing production deps in ${sliceRoot}`);
  execFileSync('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], {
    cwd: sliceRoot,
    stdio: 'inherit',
  });

  // 5. Create the `current` symlink that the resolver and downstream
  //    code (openclawConfigSync, sync-openclaw-runtime-current, etc.)
  //    expect at vendor/bundled-runtimes/openclaw/<version>/current
  const linkParent = path.dirname(sliceRoot);
  const currentLink = path.join(linkParent, 'current');
  if (fs.existsSync(currentLink) || fs.lstatSync(currentLink, { throwIfNoEntry: false })) {
    fs.rmSync(currentLink, { recursive: true, force: true });
  }
  fs.symlinkSync(slice, currentLink, 'dir');

  // 6. Pre-create the `extensions/` directory. The WeSight plugin chain
  //    (ensure-openclaw-plugins.cjs, sync-local-openclaw-extensions.cjs)
  //    populates this directory. The upstream `openclaw` npm package
  //    no longer ships an `extensions/` directory by default; creating
  //    it here keeps the chain functional. (Whether upstream openclaw
  //    2026.6.1 actually discovers plugins under `extensions/` is a
  //    separate question — see scripts/notes/openclaw-2026.6.1-plugin-shape.md
  //    when added.)
  fs.mkdirSync(path.join(sliceRoot, 'extensions'), { recursive: true });

  // 7. Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[fetchOpenClaw] done; symlinked ${currentLink} -> ${slice}`);
}

async function main() {
  // Parse --target/--all/--help first so the user can ask for help without
  // a valid manifest. The manifest is read once we know we're actually
  // going to fetch.
  const argv = process.argv.slice(2);
  let slice;
  let only;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) {
      slice = argv[i + 1];
      i++;
    } else if (argv[i] === '--all') {
      slice = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].join(',');
    } else if (argv[i] === '--only' && i + 1 < argv.length) {
      only = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: setup-bundled-runtimes.cjs [--target <platform-arch>] [--all] [--only <runtime>]');
      console.log('  default: current platform+arch (e.g. darwin-arm64)');
      console.log('  --target: explicit slice, e.g. linux-x64');
      console.log('  --all:    fetch all 4 supported slices');
      console.log('  --only:   fetch only the named runtime (e.g. gh, hermes)');
      process.exit(0);
    }
  }

  const RUNTIME_MANIFEST = readRuntimeManifest();
  parseManifest(RUNTIME_MANIFEST);

  if (!slice) {
    // Match the slice naming used by electron-builder's
    // resolveOpenClawRuntimeTargetId (mac-arm64, mac-x64, win-arm64,
    // win-x64, linux-arm64, linux-x64). This is the same shape the
    // runtime resolver (src/main/runtimeResolver.ts) expects, so the
    // vendored directory lines up with what `verifyBundledRuntimes`
    // looks for in beforePack.
    const platform =
      process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'win'
          : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    slice = `${platform}-${arch}`;
  }

  const slices = slice.includes(',') ? slice.split(',') : [slice];
  console.log(`[setup-bundled-runtimes] target slice(s): ${slices.join(', ')}`);

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
  const names = only ? [only] : Object.keys(fetchers);
  for (const s of slices) {
    for (const name of names) {
      const fetcher = fetchers[name];
      if (!fetcher) {
        console.error(`[setup-bundled-runtimes] unknown runtime: ${name}`);
        process.exit(1);
      }
      const spec = RUNTIME_MANIFEST[name];
      // Skip fetch if the slice is already on disk. Saves time on repeated
      // builds and avoids re-fetching over flaky networks. Force a re-fetch
      // by deleting vendor/bundled-runtimes/<name>/<version>/<slice>.
      const slicePath = path.join(vendorDir(name, spec.version), s);
      if (fs.existsSync(slicePath) && fs.readdirSync(slicePath).length > 0) {
        console.log(`[setup-bundled-runtimes] ${name}@${spec.version} for ${s} already present, skipping`);
        continue;
      }
      console.log(`[setup-bundled-runtimes] fetching ${name}@${spec.version} for ${s}...`);
      try {
        await fetcher(spec.version, s, spec.sha256);
      } catch (err) {
        console.error(`[setup-bundled-runtimes] ${name}@${s} FAILED: ${err.message}`);
        throw err;
      }
    }
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
