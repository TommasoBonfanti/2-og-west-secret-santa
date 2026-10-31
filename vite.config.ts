/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // A production build without Supabase config would silently fall back to demo
  // mode (data in each browser's localStorage). Refuse instead.
  if (command === 'build' && env.VITE_DEMO !== '1' && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (or build with --mode demo).');
  }

  return {
    // Relative base so the build works under https://<user>.github.io/<repo>/
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
      },
    },
    test: {
      environment: 'node',
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
    },
  };
});
