import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The One — web dev server (5173), proxies /api → API (5174) so the browser
// only ever calls same-origin /api/* and no CORS is needed (SPRINT1-SPEC §5).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
    },
  },
});
