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
    // Pinned to IPv4 loopback. Vite's default (`localhost`) resolves to `::1`
    // on Windows, so the dev server ends up listening on IPv6 only and
    // http://127.0.0.1:5173 — the address the docs give — refuses the
    // connection. Both spellings work once this is explicit.
    host: '127.0.0.1',
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
