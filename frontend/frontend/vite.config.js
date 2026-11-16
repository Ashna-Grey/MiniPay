import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The refresh cookie is SameSite=Strict on /api/auth, so the UI and API must share an origin.
// In dev, Vite proxies /api to the backend. In production, serve both behind one reverse proxy.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.API_URL || 'http://localhost:4000', changeOrigin: false } } },
});
