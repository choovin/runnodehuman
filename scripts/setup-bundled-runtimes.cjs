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
  fs.writeFileSync(
    path.join(sliceRoot, 'slice.json'),
    JSON.stringify({ name, version, slice, files }, null, 2)
  );
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
  const tar = require('tar');
  const [platform, arch] = slice.split('-');
  let url, archiveExt;
  if (platform === 'darwin') {
    url = `${NODE_BASE}/v${version}/node-v${version}-darwin-${arch}.tar.xz`;
    archiveExt = 'tar.xz';
  } else if (platform === 'linux') {
    url = `${NODE_BASE}/v${version}/node-v${version}-linux-${arch}.tar.xz`;
    archiveExt = 'tar.xz';
  } else if (platform === 'win32') {
    url = `${NODE_BASE}/v${version}/node-v${version}-win-x64.7z`;
    archiveExt = '7z';
  }
  if (!url) throw new Error(`unsupported node slice: ${slice}`);
  const ext = archiveExt.split('.').pop();
  const destRel = `node-v${version}-${platform}-${arch}.${ext}`;
  const destAbs = await downloadAndVerify({
    name: 'node',
    version,
    url,
    destRel,
    expectedSha256,
  });
  const extractRoot = path.join(vendorDir('node', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({
    file: destAbs,
    cwd: extractRoot,
    strip: 1,
  });
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
  if (slice.startsWith('win32')) {
    const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
    const destRel = `python-${version}-embed-amd64.zip`;
    const destAbs = await downloadAndVerify({ name: 'python', version, url, destRel, expectedSha256 });
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
  if (slice.startsWith('win32')) {
    const url = `https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/MinGit-${version}-64-bit.zip`;
    const destRel = `MinGit-${version}-64-bit.zip`;
    const destAbs = await downloadAndVerify({ name: 'git', version, url, destRel, expectedSha256 });
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
  // Upstream: https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_<os>_<arch>.tar.gz
  //
  // gh 2.65.0: gh_2.65.0_macOS_amd64.tar.gz / gh_2.65.0_linux_amd64.tar.gz / gh_2.65.0_windows_amd64.zip
  const tar = require('tar');
  const [platform, arch] = slice.split('-');
  const platformSlug =
    platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'windows' : 'linux';
  const archSlug = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : 'amd64';
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const url = `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_${platformSlug}_${archSlug}.${ext}`;
  const destRel = `gh_${version}_${platformSlug}_${archSlug}.${ext}`;
  const destAbs = await downloadAndVerify({ name: 'gh', version, url, destRel, expectedSha256 });
  const extractRoot = path.join(vendorDir('gh', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  if (ext === 'tar.gz') {
    await tar.x({ file: destAbs, cwd: extractRoot, strip: 1 });
  } else {
    const { execFileSync } = require('child_process');
    execFileSync('unzip', ['-q', destAbs, '-d', extractRoot], { stdio: 'inherit' });
  }
  fs.rmSync(destAbs);
}

async function fetchClaudeCode(version, slice, expectedSha256) {
  // Upstream: npm registry, package @anthropic-ai/claude-code
  //   npm pack @anthropic-ai/claude-code@<version> --pack-destination <tmp>
  //   tar -xf <packed>.tgz
  const tar = require('tar');
  const { execFileSync } = require('child_process');
  const tmpDir = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', 'claudecode', version, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const packedTar = path.join(tmpDir, `claudecode-${version}.tgz`);
  execFileSync('npm', ['pack', `@anthropic-ai/claude-code@${version}`, '--pack-destination', tmpDir], {
    stdio: 'inherit',
  });
  const extractRoot = path.join(vendorDir('claudecode', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({ file: packedTar, cwd: extractRoot, strip: 1 });
  // Verify SHA-256 of the tarball for the manifest record.
  const actual = sha256OfFile(packedTar);
  if (actual !== expectedSha256) {
    throw new Error(`claudecode: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  fs.rmSync(packedTar, { recursive: true, force: true });
}

async function fetchCodex(version, slice, expectedSha256) {
  // Upstream: npm registry, package @openai/codex
  const tar = require('tar');
  const { execFileSync } = require('child_process');
  const tmpDir = path.join(PROJECT_ROOT, 'vendor', 'bundled-runtimes', 'codex', version, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const packedTar = path.join(tmpDir, `codex-${version}.tgz`);
  execFileSync('npm', ['pack', `@openai/codex@${version}`, '--pack-destination', tmpDir], {
    stdio: 'inherit',
  });
  const extractRoot = path.join(vendorDir('codex', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  await tar.x({ file: packedTar, cwd: extractRoot, strip: 1 });
  const actual = sha256OfFile(packedTar);
  if (actual !== expectedSha256) {
    throw new Error(`codex: sha256 mismatch (expected ${expectedSha256}, got ${actual})`);
  }
  fs.rmSync(packedTar, { recursive: true, force: true });
}

async function fetchHermes(version, slice, expectedSha256) {
  // Upstream: https://github.com/NousResearch/hermes-agent/releases
  //   hermes-agent-<platform>-<arch>.<ext>
  const tar = require('tar');
  const [platform, arch] = slice.split('-');
  const platformSlug = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  const archSlug = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'i386' : 'x64';
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const url = `https://github.com/NousResearch/hermes-agent/releases/download/${version}/hermes-agent-${platformSlug}-${archSlug}.${ext}`;
  const destRel = `hermes-agent-${platformSlug}-${archSlug}.${ext}`;
  const destAbs = await downloadAndVerify({ name: 'hermes', version, url, destRel, expectedSha256 });
  const extractRoot = path.join(vendorDir('hermes', version), slice);
  fs.mkdirSync(extractRoot, { recursive: true });
  if (ext === 'tar.gz') {
    await tar.x({ file: destAbs, cwd: extractRoot, strip: 1 });
  } else {
    const { execFileSync } = require('child_process');
    execFileSync('unzip', ['-q', destAbs, '-d', extractRoot], { stdio: 'inherit' });
  }
  fs.rmSync(destAbs);
}

async function fetchOpenClaw(version, slice, expectedSha256) {
  // OpenClaw has a non-trivial build chain. The existing
  // `openclaw:runtime:<target>` npm scripts invoke scripts/build-openclaw-runtime.sh
  // which writes the output to vendor/bundled-runtimes/openclaw/<version>/<target>/
  // (post-Task-16 migration). We shell out to that flow.
  const { execFileSync } = require('child_process');
  const target = slice; // 'darwin-arm64' | 'win-x64' | 'linux-x64' | ...
  const script = `openclaw:runtime:${target}`;
  console.log(`[fetchOpenClaw] delegating to npm run ${script}`);
  execFileSync('npm', ['run', script], { stdio: 'inherit' });
}

async function main() {
  const RUNTIME_MANIFEST = readRuntimeManifest();
  parseManifest(RUNTIME_MANIFEST);
  const slice = (() => {
    const platform =
      process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'win32'
          ? 'win32'
          : 'linux';
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
