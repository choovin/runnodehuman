import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// https://vitejs.dev/config/
const devPort = 5175;
const katexVersion = process.env.npm_package_dependencies_katex?.replace(/^[~^]/, '') || '0.16.0';

// Read environment files explicitly via loadEnv so the production build picks
// up `.env.production` (and `.env.production.local`) without relying on the
// ambient `process.env` being populated by the developer's shell. This
// mirrors the pattern used by RClaw's vite.config.ts and ensures that
// `VITE_CLOUD_API_BASE_URL` (and any future VITE_* values) is baked into the
// renderer/main bundles at build time, not only in dev mode.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

export default defineConfig({
  define: {
    // KaTeX ESM bundle references this compile-time constant.
    __VERSION__: JSON.stringify(katexVersion),
    'import.meta.env.VITE_CLOUD_API_BASE_URL': JSON.stringify(
      env.VITE_CLOUD_API_BASE_URL ?? process.env.VITE_CLOUD_API_BASE_URL ?? ''
    ),
  },
  plugins: [
    react(),
    electron([
      {
        // 主进程入口文件
        entry: 'src/main/main.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              external: (id) => {
                const staticExternals = ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'discord.js', 'zlib-sync', '@discordjs/opus', 'bufferutil', 'utf-8-validate', 'node-nim', 'nim-web-sdk-ng'];
                if (staticExternals.includes(id)) return true;
                if (id.startsWith('@larksuite/openclaw-lark-tools') || id.startsWith('@larksuite/openclaw-lark')) return true;
                return false;
              },
              output: {
                // Keep CJS format (default), but load via ESM loader.mjs
                inlineDynamicImports: true,
              },
            },
          },
        },
        onstart() {
          // Signal that the main process bundle is ready for electron to load
          fs.writeFileSync('dist-electron/.electron-ready', '');
        },
      },
      {
        // 预加载脚本入口文件
        entry: 'src/main/preload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: false,
          },
        },
        onstart() {},
      },
    ]),
    renderer(),
  ],
  base: process.env.NODE_ENV === 'development' ? '/' : './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    hmr: {
      port: devPort,
    },
    watch: {
      usePolling: false,
      ignored: [
        '**/vendor/openclaw-runtime/**',
        '**/vendor/openclaw-plugins/**',
        '**/vendor/hermes-runtime/**',
      ],
    },
  },
  optimizeDeps: {
    exclude: ['electron', '@larksuite/openclaw-lark-tools', '@larksuite/openclaw-lark'],
    esbuildOptions: {
      define: {
        __VERSION__: JSON.stringify(katexVersion),
      },
    },
  },
  clearScreen: false,
});
