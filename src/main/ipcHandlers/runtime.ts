import { ipcMain } from 'electron';
import { RuntimeName } from '../../shared/runtime/constants';
import type { RuntimeResolver } from '../runtimeResolver';

export const RuntimeIpcChannel = {
  GetHealth: 'runtime:get-health',
} as const;

export interface SerializedRuntimeHealth {
  ok: true;
  runtimes: Array<{
    name: RuntimeName;
    ok: boolean;
    path: string | null;
    version: string;
  }>;
}

export function registerRuntimeHandlers(resolver: RuntimeResolver): void {
  ipcMain.handle(RuntimeIpcChannel.GetHealth, (): SerializedRuntimeHealth => {
    const health = resolver.getHealth();
    const runtimes = Array.from(health.entries()).map(([name, value]) => ({
      name,
      ok: value !== null,
      path: value === null ? null : value.path,
      version: value === null ? '' : value.version,
    }));
    return { ok: true, runtimes };
  });
}
