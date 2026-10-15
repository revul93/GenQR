import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs separately on :3000; in production the server serves client/dist.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
