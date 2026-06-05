import { createHash } from 'crypto';
import { app } from 'electron';
import { machineIdSync } from 'node-machine-id';

let cachedKey: Buffer | null = null;

export function deriveSqlcipherKey(): Buffer {
  if (cachedKey) return cachedKey;

  let machineKey: string;
  try {
    machineKey = machineIdSync();
  } catch {
    machineKey = app.getPath('userData');
  }

  cachedKey = createHash('sha256')
    .update(`WeSight-CloudDB-v1\0${machineKey}\0${app.getName()}`)
    .digest();
  return cachedKey;
}
