import { describe, expect, test } from 'vitest';
import { stripQuarantineIfNeeded } from './runtimeHealth';

describe('stripQuarantineIfNeeded', () => {
  test('is a no-op on non-darwin platforms', () => {
    if (process.platform === 'darwin') return; // skip on darwin
    expect(() => stripQuarantineIfNeeded('/nonexistent')).not.toThrow();
  });

  test('does not throw when wesight-runtime dir does not exist', () => {
    if (process.platform !== 'darwin') return;
    expect(() => stripQuarantineIfNeeded('/definitely/not/a/real/path')).not.toThrow();
  });
});
