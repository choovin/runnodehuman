export interface RuntimeVersionSpec {
  version: string;
  sha256: string;
}

export interface RuntimeManifest {
  node: RuntimeVersionSpec;
  python: RuntimeVersionSpec;
  git: RuntimeVersionSpec;
  gh: RuntimeVersionSpec;
  claudecode: RuntimeVersionSpec;
  codex: RuntimeVersionSpec;
  hermes: RuntimeVersionSpec;
  openclaw: RuntimeVersionSpec;
}

export type ParserResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const SHA256_RE = /^[0-9a-f]{64}$/i;

function isVersionSpec(x: unknown): x is RuntimeVersionSpec {
  if (x == null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.version !== 'string' || o.version.length === 0) return false;
  if (typeof o.sha256 !== 'string' || !SHA256_RE.test(o.sha256)) return false;
  return true;
}

export function parseRuntimeManifest(raw: unknown): ParserResult<RuntimeManifest> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest is not an object' };
  }
  const o = raw as Record<string, unknown>;
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
    if (!isVersionSpec(o[name])) {
      const spec = o[name] as Record<string, unknown> | undefined;
      const detail =
        spec == null
          ? 'missing entry'
          : typeof spec.sha256 !== 'string'
            ? 'sha256 must be a string'
            : !SHA256_RE.test(spec.sha256)
              ? 'sha256 must be 64 hex characters'
              : typeof spec.version !== 'string' || spec.version.length === 0
                ? 'version must be a non-empty string'
                : 'invalid entry';
      return { ok: false, error: `${name}: ${detail}` };
    }
  }
  return { ok: true, value: o as unknown as RuntimeManifest };
}
