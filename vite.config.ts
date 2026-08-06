import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    // genlayer-js pulls in viem and lands around 550 kB. It is deferred behind a
    // dynamic import, so the markets list never downloads it; the warning would
    // only be noise about a chunk that is already code-split.
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
