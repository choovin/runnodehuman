export const RuntimeName = {
  Node: 'node',
  Python: 'python',
  Git: 'git',
  Gh: 'gh',
  ClaudeCode: 'claudecode',
  Codex: 'codex',
  Hermes: 'hermes',
  OpenClaw: 'openclaw',
} as const;
export type RuntimeName = (typeof RuntimeName)[keyof typeof RuntimeName];

export const RUNTIME_NAMES: readonly RuntimeName[] = Object.values(RuntimeName);

export function isRuntimeName(x: unknown): x is RuntimeName {
  return typeof x === 'string' && (RUNTIME_NAMES as readonly string[]).includes(x);
}
