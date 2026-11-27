import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Rust server runs on :8080 and Vite proxies /api to it,
// so cookies and same-origin checks behave as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
