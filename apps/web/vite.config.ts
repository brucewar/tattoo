import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  // The server consumes CommonJS output; Vite compiles the same contracts from TypeScript.
  resolve: {
    alias: {
      '@tattoo/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.TATTOO_API_PROXY ?? 'http://127.0.0.1:3000' },
  },
  build: { sourcemap: false },
});
