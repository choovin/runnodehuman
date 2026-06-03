import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

 
const iconv = require('iconv-lite') as typeof import('iconv-lite');

import packageJson from '../../../package.json';
import type { CodexAppManager } from './codexAppManager';

export type CodexAppJsonRpcId = number | string;

export interface CodexAppJsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface CodexAppServerRequest {
  id: CodexAppJsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerClientStatus {
  connected: boolean;
  connecting: boolean;
  socketPath: string;
  cliPath: string | null;
  lastConnectedAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexAppServerClientEvents {
  request: [CodexAppServerRequest];
  notification: [CodexAppServerNotification];
  disconnect: [Error | null];
}

const JsonRpcMethod = {
  Initialize: 'initialize',
  Initialized: 'initialized',
} as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;
const SERVER_START_TIMEOUT_MS = 15_000;
const WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const getCodexAppServerSocketPath = (): string => (
  path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
);

export class CodexAppServerClient extends EventEmitter {
  private readonly manager: CodexAppManager;
  private readonly socketPath = getCodexAppServerSocketPath();
  private socket: net.Socket | null = null;
  private serverProcess: ChildProcessWithoutNullStreams | null = null;
  private connectPromise: Promise<void> | null = null;
  private initialized = false;
  private requestSeq = 1;
  private frameBuffer = Buffer.alloc(0);
  private fragmentChunks: Buffer[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private lastConnectedAt: number | null = null;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private cliPath: string | null = null;
  private stderrTail = '';

  constructor(manager: CodexAppManager) {
    super();
    this.manager = manager;
  }

  override on<U extends keyof CodexAppServerClientEvents>(
    event: U,
    listener: (...args: CodexAppServerClientEvents[U]) => void,
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CodexAppServerClientEvents>(
    event: U,
    listener: (...args: CodexAppServerClientEvents[U]) => void,
  ): this {
    return super.off(event, listener);
  }

  getStatus(): CodexAppServerClientStatus {
    return {
      connected: Boolean(this.socket && !this.socket.destroyed && this.initialized),
      connecting: Boolean(this.connectPromise),
      socketPath: this.socketPath,
      cliPath: this.cliPath,
      lastConnectedAt: this.lastConnectedAt,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  markSynced(): void {
    this.lastSyncAt = Date.now();
  }

  async ensureConnected(cwd?: string): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.initialized) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect(cwd)
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  async sendRequest(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      await this.ensureConnected();
    }
    const id = this.requestSeq;
    this.requestSeq += 1;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`Codex App request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(key, { method, resolve, reject, timer });
      this.sendMessage({ id, method, params });
    });
  }

  sendNotification(method: string, params: unknown): void {
    this.sendMessage({ method, params });
  }

  sendResponse(id: CodexAppJsonRpcId, result: unknown): void {
    this.sendMessage({ id, result });
  }

  sendErrorResponse(id: CodexAppJsonRpcId, error: CodexAppJsonRpcError): void {
    this.sendMessage({ id, error });
  }

  disconnect(): void {
    this.rejectPendingRequests('Codex App app-server disconnected.');
    this.initialized = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }
    this.serverProcess = null;
  }

  private async connect(cwd?: string): Promise<void> {
    const status = this.manager.getStatus();
    if (!status.cliFound || !status.cliPath || !status.appServerSupported) {
      throw new Error(status.error || status.message || 'Codex App app-server is not available.');
    }
    this.cliPath = status.cliPath;

    try {
      await this.openWebSocket();
    } catch {
      this.startServerProcess(status.cliPath, cwd);
      await this.waitForSocketFile();
      await this.openWebSocket();
    }

    await this.initializeProtocol();
  }

  private startServerProcess(cliPath: string, cwd?: string): void {
    if (this.serverProcess && !this.serverProcess.killed) return;

    const processCwd = cwd?.trim() && fs.existsSync(cwd) ? cwd : os.homedir();
    const child = spawn(cliPath, ['app-server', '--listen', 'unix://'], {
      cwd: processCwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    this.serverProcess = child;
    child.stderr.on('data', (chunk: Buffer) => {
      // On Chinese Windows, the app-server process may output text in the
      // system's active code page (e.g. GBK/936) instead of UTF-8.  Try UTF-8
      // first; if the result contains replacement characters (U+FFFD), fall
      // back to GBK decoding via iconv-lite.
      let text = chunk.toString('utf8');
      if (process.platform === 'win32' && text.includes('\uFFFD')) {
        try {
          const gbk = iconv.decode(chunk, 'cp936');
          if (!gbk.includes('\uFFFD')) text = gbk;
        } catch {
          // iconv-lite decode failed; keep the UTF-8 attempt
        }
      }
      this.stderrTail = `${this.stderrTail}${text}`.slice(-12_000);
    });
    child.on('error', (error) => {
      this.lastError = error.message;
    });
    child.on('close', (code, signal) => {
      if (this.serverProcess !== child) return;
      this.serverProcess = null;
      if (this.socket && !this.socket.destroyed) return;
      const suffix = signal ? ` (${signal})` : '';
      this.lastError = `Codex App app-server exited with code ${code ?? 'unknown'}${suffix}.`;
    });
  }

  private async waitForSocketFile(): Promise<void> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (fs.statSync(this.socketPath).isSocket()) return;
      } catch {
        // Wait until the app-server creates the control socket.
      }
      await sleep(200);
    }

    const stderr = this.stderrTail.trim();
    throw new Error(stderr
      ? `Codex App app-server did not create its socket in time.\n\n${stderr}`
      : 'Codex App app-server did not create its socket in time.');
  }

  private openWebSocket(): Promise<void> {
    this.frameBuffer = Buffer.alloc(0);
    this.fragmentChunks = [];

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const key = crypto.randomBytes(16).toString('base64');
      let handshakeBuffer = Buffer.alloc(0);
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.off('data', onHandshakeData);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('Codex App app-server socket connection timed out.'));
      }, CONNECT_TIMEOUT_MS);
      const onError = (error: Error): void => fail(error);
      const onHandshakeData = (chunk: Buffer): void => {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;

        const header = handshakeBuffer.slice(0, headerEnd).toString('utf8');
        if (!/^HTTP\/1\.1 101\b/i.test(header)) {
          fail(new Error(`Codex App app-server rejected the WebSocket handshake: ${header.split('\r\n')[0] || 'unknown response'}`));
          return;
        }

        const acceptHeader = header
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(line => /^sec-websocket-accept:/i.test(line));
        const expected = crypto
          .createHash('sha1')
          .update(`${key}${WEBSOCKET_MAGIC}`)
          .digest('base64');
        if (acceptHeader && acceptHeader.split(':').slice(1).join(':').trim() !== expected) {
          fail(new Error('Codex App app-server returned an invalid WebSocket accept header.'));
          return;
        }

        settled = true;
        cleanup();
        this.socket = socket;
        this.initialized = false;
        this.lastConnectedAt = Date.now();
        this.lastError = null;
        socket.on('data', (data) => this.handleFrameData(data));
        socket.on('close', () => this.handleSocketClosed(null));
        socket.on('error', (error) => this.handleSocketClosed(error));
        const leftover = handshakeBuffer.slice(headerEnd + 4);
        if (leftover.length > 0) {
          this.handleFrameData(leftover);
        }
        resolve();
      };

      socket.once('error', onError);
      socket.on('data', onHandshakeData);
      socket.once('connect', () => {
        socket.write([
          'GET / HTTP/1.1',
          'Host: localhost',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'));
      });
    });
  }

  private async initializeProtocol(): Promise<void> {
    await this.sendRequest(JsonRpcMethod.Initialize, {
      version: 1,
      clientInfo: {
        name: 'wesight',
        title: 'WeSight',
        version: packageJson.version || '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    }, 15_000);
    this.sendNotification(JsonRpcMethod.Initialized, {});
    this.initialized = true;
  }

  private sendMessage(message: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Codex App app-server is not connected.');
    }
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.socket.write(this.buildClientFrame(payload, 0x1));
  }

  private buildClientFrame(payload: Buffer, opcode: number): Buffer {
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }

    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    return Buffer.concat([header, mask, masked]);
  }

  private handleFrameData(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.frameBuffer.length < offset + 2) return;
        payloadLength = this.frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.frameBuffer.length < offset + 8) return;
        const high = this.frameBuffer.readUInt32BE(offset);
        const low = this.frameBuffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          this.handleSocketClosed(new Error('Codex App app-server sent an oversized WebSocket frame.'));
          return;
        }
        payloadLength = low;
        offset += 8;
      }

      const maskOffset = masked ? 4 : 0;
      if (this.frameBuffer.length < offset + maskOffset + payloadLength) return;

      const mask = masked ? this.frameBuffer.slice(offset, offset + 4) : null;
      offset += maskOffset;
      let payload = this.frameBuffer.slice(offset, offset + payloadLength);
      this.frameBuffer = this.frameBuffer.slice(offset + payloadLength);
      if (mask) {
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }

      this.handleFrame(opcode, payload, fin);
    }
  }

  private handleFrame(opcode: number, payload: Buffer, fin: boolean): void {
    if (opcode === 0x8) {
      this.disconnect();
      return;
    }
    if (opcode === 0x9) {
      this.socket?.write(this.buildClientFrame(payload, 0xA));
      return;
    }
    if (opcode === 0xA) return;

    if (opcode === 0x1 || opcode === 0x0) {
      this.fragmentChunks.push(payload);
      if (!fin) return;
      const text = Buffer.concat(this.fragmentChunks).toString('utf8');
      this.fragmentChunks = [];
      this.handleTextMessage(text);
    }
  }

  private handleTextMessage(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      console.debug('[CodexAppServerClient] ignored non-JSON WebSocket message:', error);
      return;
    }
    if (!isRecord(message)) return;

    if ('id' in message && ('result' in message || 'error' in message)) {
      this.handleResponse(message);
      return;
    }
    if ('id' in message && typeof message.method === 'string') {
      this.emit('request', {
        id: message.id as CodexAppJsonRpcId,
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
      });
      return;
    }
    if (typeof message.method === 'string') {
      this.emit('notification', {
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
      });
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const key = String(message.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) return;
    this.pendingRequests.delete(key);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const errorMessage = typeof message.error.message === 'string'
        ? message.error.message
        : `Codex App request failed: ${pending.method}`;
      pending.reject(new Error(errorMessage));
      return;
    }
    pending.resolve(message.result);
  }

  private handleSocketClosed(error: Error | null): void {
    if (error) {
      this.lastError = error.message;
    }
    this.initialized = false;
    this.socket = null;
    this.rejectPendingRequests(error?.message || 'Codex App app-server disconnected.');
    this.emit('disconnect', error);
  }

  private rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }
}
