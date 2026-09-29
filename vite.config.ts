import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build:standalone` (mode "standalone") is configured by the export/standalone module.
export default defineConfig(({ mode }) => ({
  base: './',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react()],
  define: {
    'import.meta.env.VITE_STANDALONE': JSON.stringify(mode === 'standalone' ? '1' : ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
}));
