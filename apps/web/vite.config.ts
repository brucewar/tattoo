import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? (process.env.TATTOO_PAGES_BASE ?? './') : '/',
  plugins: [react(), tailwindcss()],
  // The server consumes CommonJS output; Vite compiles the same contracts from TypeScript.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tattoo/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.TATTOO_API_PROXY ?? 'http://127.0.0.1:3000' },
  },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: false, outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
}));
