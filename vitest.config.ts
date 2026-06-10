import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      electron: path.resolve(__dirname, './src/test/mocks/electron.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'happy-dom',
    environmentMatchGlobs: [
      ['src/renderer/components/**/*.test.ts', 'node'],
    ],
  },
});
