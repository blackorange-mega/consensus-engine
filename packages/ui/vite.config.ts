import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The UI is a separate process from the engine and talks to it only over
 * HTTP/WebSocket. That is what makes the phone path work: the
 * desktop runs the engine, the phone opens this same bundle over the LAN.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
