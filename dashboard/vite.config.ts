import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the API at /dashboard/; in dev, /v1 calls are proxied to the API on :3000.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: { proxy: { '/v1': 'http://localhost:3000' } },
});
