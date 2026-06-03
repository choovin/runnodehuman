import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

 
const iconv = require('iconv-lite') as typeof import('iconv-lite');

import { getCodexAppServerSocketPath } from './codexAppServerClient';

export const CodexAppStatusPhase = {
  Missing: 'missing',
  Ready: 'ready',
  Starting: 'starting',
  Error: 'error',
} as const;

export type CodexAppStatusPhase = typeof CodexAppStatusPhase[keyof typeof CodexAppStatusPhase];

export interface CodexAppStatus {
  phase: CodexAppStatusPhase;
  cliFound: boolean;
  cliPath: string | null;
  cliVersion: string | null;
  appInstalled: boolean;
  appPath: string | null;
  appRunning: boolean;
  socketPath: string | null;
  appServerSupported: boolean;
  message: string;
  error?: string;
}

const CODEX_APP_PATH = '/Applications/Codex.app';
const COMMAND_TIMEOUT_MS = 10_000;
const START_WAIT_TIMEOUT_MS = 12_000;
const START_WAIT_INTERVAL_MS = 500;

const quoteForShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Decode a Buffer from a Windows child process, which may use the system's
 * active code page (e.g. GBK/936 on Chinese Windows) instead of UTF-8.
 *
 * Node's spawnSync with encoding:'utf8' blindly calls buf.toString('utf8'),
 * producing garbled characters (mojibake) when the actual encoding is GBK.
 * This helper tries UTF-8 first; if the result contains replacement characters
 * (U+FFFD), it falls back to the Windows ANSI code page (typically GBK/936).
 */
const decodeWindowsOutput = (buf: Buffer): string => {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  // On modern Windows 10/11 with UTF-8 beta support enabled, the output
  // may already be valid UTF-8.
  if (!utf8.includes('\uFFFD')) return utf8;

  // Fall back to the system's legacy ANSI code page (GBK on Chinese Windows).
  try {
    // cp936 = GBK (Simplified Chinese), the most common non-UTF-8 code page
    const gbk = iconv.decode(buf, 'cp936');
    // If GBK decoding also produces replacement chars, just return the UTF-8
    // version anyway — it's the best we can do without knowing the exact locale.
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch {
    // iconv-lite decode failed; return UTF-8 attempt
  }
  return utf8;
};

/**
 * Thin wrapper around spawnSync that decodes stdout/stderr from Buffer using
 * Windows-aware encoding on win32, and plain UTF-8 on other platforms.
 *
 * On Windows, the `encoding` option is forced to `'buffer'` so that raw bytes
 * are returned.  The caller's stdout/stderr will be strings decoded via
 * {@link decodeWindowsOutput}.
 */
const spawnSyncSafe = (
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): { stdout: string; stderr: string; status: number | null; error?: Error } => {
  if (process.platform === 'win32') {
    // Force buffer output on Windows to avoid garbled UTF-8 decoding.
    // Node's spawnSync returns Buffer when encoding is omitted or set to
    // 'buffer', but TypeScript's type defs don't narrow this correctly.
    const result = spawnSync(command, args, {
      ...options,
      encoding: 'buffer' as BufferEncoding,
    });
    const stdout = decodeWindowsOutput(result.stdout as unknown as Buffer);
    const stderr = decodeWindowsOutput(result.stderr as unknown as Buffer);
    return {
      stdout,
      stderr,
      status: result.status,
      error: result.error,
    };
  }
  // On macOS / Linux, UTF-8 is universal
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    status: result.status,
    error: result.error,
  };
};

const resolveCommand = (command: string): { path: string | null; error: string | null } => {
  const result = spawnSyncSafe(process.platform === 'win32' ? 'where' : 'which', [command], {
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status === 0) {
    const commandPath = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
    if (commandPath) return { path: commandPath, error: null };
  }

  if (process.platform !== 'win32') {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const shellResult = spawnSync(shellPath, ['-lc', `command -v ${quoteForShell(command)}`], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: [
          path.join(os.homedir(), '.npm-global', 'bin'),
          path.join(os.homedir(), '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          process.env.PATH ?? '',
        ].join(path.delimiter),
      },
    });
    if (shellResult.status === 0) {
      const commandPath = shellResult.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
      if (commandPath) return { path: commandPath, error: null };
    }
    const error = (shellResult.stderr || shellResult.stdout || result.stderr || result.stdout || '').trim();
    return { path: null, error: error || `${command} was not found in PATH.` };
  }

  const error = (result.stderr || result.stdout || '').trim();
  return { path: null, error: error || `${command} was not found in PATH.` };
};

const readCommandVersion = (commandPath: string): string | null => {
  const result = spawnSyncSafe(commandPath, ['--version'], {
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || null;
};

const supportsAppServer = (commandPath: string): boolean => {
  const result = spawnSyncSafe(commandPath, ['app-server', '--help'], {
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0 && /app-server/i.test(`${result.stdout}\n${result.stderr}`);
};

const isCodexAppRunning = (): boolean => {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('pgrep', ['-f', '/Applications/Codex.app/Contents/MacOS/Codex'], {
    encoding: 'utf8',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0 && result.stdout.trim().length > 0;
};

const findCodexIpcSocket = (): string | null => {
  if (process.platform !== 'darwin') return null;
  const tempDir = os.tmpdir();
  const candidates: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'codex-ipc') {
          let socketEntries: string[];
          try {
            socketEntries = fs.readdirSync(entryPath);
          } catch {
            continue;
          }
          socketEntries
            .filter((name) => /^ipc-.*\.sock$/.test(name))
            .forEach((name) => candidates.push(path.join(entryPath, name)));
          continue;
        }
        visit(entryPath, depth + 1);
      }
    }
  };
  visit(tempDir, 0);
  return candidates
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isSocket();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return left.localeCompare(right);
      }
    })[0] ?? null;
};

const findCodexAppServerSocket = (): string | null => {
  const socketPath = getCodexAppServerSocketPath();
  try {
    return fs.statSync(socketPath).isSocket() ? socketPath : null;
  } catch {
    return null;
  }
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class CodexAppManager {
  getStatus(): CodexAppStatus {
    const command = resolveCommand('codex');
    const cliFound = Boolean(command.path);
    const appInstalled = process.platform === 'darwin' && fs.existsSync(CODEX_APP_PATH);
    const appRunning = isCodexAppRunning();
    const appServerSupported = command.path ? supportsAppServer(command.path) : false;
    const socketPath = findCodexAppServerSocket() || findCodexIpcSocket();
    const phase = !cliFound || !appInstalled || !appServerSupported
      ? CodexAppStatusPhase.Missing
      : CodexAppStatusPhase.Ready;
    const missingParts = [
      !cliFound ? 'Codex CLI' : '',
      !appInstalled ? 'Codex.app' : '',
      cliFound && !appServerSupported ? 'Codex app-server' : '',
    ].filter(Boolean);

    return {
      phase,
      cliFound,
      cliPath: command.path,
      cliVersion: command.path ? readCommandVersion(command.path) : null,
      appInstalled,
      appPath: appInstalled ? CODEX_APP_PATH : null,
      appRunning,
      socketPath,
      appServerSupported,
      message: missingParts.length > 0
        ? `Missing ${missingParts.join(', ')}.`
        : appRunning
          ? 'Codex App is running.'
          : 'Codex App is installed and ready to launch.',
      error: command.error ?? undefined,
    };
  }

  async start(cwd?: string): Promise<CodexAppStatus> {
    const before = this.getStatus();
    if (!before.cliFound || !before.cliPath || !before.appInstalled || !before.appServerSupported) {
      return {
        ...before,
        phase: CodexAppStatusPhase.Missing,
      };
    }

    if (!before.appRunning) {
      const args = ['app'];
      if (cwd?.trim()) {
        args.push(path.resolve(cwd.trim()));
      }
      const child = spawn(before.cliPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      });
      child.unref();
    }

    const deadline = Date.now() + START_WAIT_TIMEOUT_MS;
    let latest = this.getStatus();
    while (Date.now() < deadline) {
      latest = this.getStatus();
      if (latest.appRunning) {
        return {
          ...latest,
          phase: CodexAppStatusPhase.Ready,
          message: latest.socketPath
            ? 'Codex App is running and app-server socket was detected.'
            : 'Codex App is running. WeSight will use Codex app-server for sessions.',
        };
      }
      await sleep(START_WAIT_INTERVAL_MS);
    }

    return {
      ...latest,
      phase: latest.appRunning ? CodexAppStatusPhase.Ready : CodexAppStatusPhase.Error,
      message: latest.appRunning ? latest.message : 'Codex App did not become ready in time.',
      error: latest.appRunning ? undefined : 'Codex App launch timed out.',
    };
  }

  async ensureReady(cwd?: string): Promise<CodexAppStatus> {
    const status = this.getStatus();
    if (status.phase === CodexAppStatusPhase.Ready && status.appRunning) {
      return status;
    }
    return this.start(cwd);
  }
}
