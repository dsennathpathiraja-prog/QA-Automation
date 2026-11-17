import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development only: the API's dev session resolver trusts these headers; the production build and the
// production API ignore them entirely (OIDC session cookies are the only way in).
const devHeaders = {
  'x-dev-user': process.env.DEV_USER ?? 'dev-user',
  'x-dev-groups': process.env.DEV_GROUPS ?? 'QA-Platform-Leads',
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', headers: devHeaders },
      '/healthz': process.env.API_URL ?? 'http://127.0.0.1:3000',
    },
  },
});
