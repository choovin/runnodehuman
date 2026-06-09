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
async function fetchPython(version, slice) {
  throw new Error('fetchPython: not yet implemented');
}
async function fetchGit(version, slice) {
  throw new Error('fetchGit: not yet implemented');
}
async function fetchGh(version, slice) {
  throw new Error('fetchGh: not yet implemented');
}
async function fetchClaudeCode(version, slice) {
  throw new Error('fetchClaudeCode: not yet implemented');
}
async function fetchCodex(version, slice) {
  throw new Error('fetchCodex: not yet implemented');
}
async function fetchHermes(version, slice) {
  throw new Error('fetchHermes: not yet implemented');
}
async function fetchOpenClaw(version, slice) {
  throw new Error('fetchOpenClaw: not yet implemented');
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
