import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { vercelPreview } from './vercel-preview.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), vercelPreview(fileURLToPath(new URL('../vercel.json', import.meta.url)))],
  server: {
    port: 5173,
    // CORS on the API allows one exact origin, so never move to another port.
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
    // Same origin as on Vercel: the production build calls the relative /api.
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000' },
    },
  },
});
