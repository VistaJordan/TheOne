import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The One — web dev server (5173), proxies /api → API (5174) so the browser
// only ever calls same-origin /api/* and no CORS is needed (SPRINT1-SPEC §5).
export default defineConfig({
  plugins: [react()],
  server: {
    // IPv4 loopback explicitly. Left to its default, Node binds "localhost"
    // to ::1 only, so http://127.0.0.1:5173 (or any browser that prefers v4)
    // gets nothing — while the API on :5174 is v4-only. Same address family
    // on both sides, and the proxy target below matches it.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
});
