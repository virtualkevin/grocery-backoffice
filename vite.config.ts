import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: {
      strict: true,
      allow: [process.cwd()],
      // The dev server shares a repository with private supplier state and keys.
      // API projections alone do not protect direct Vite source-file requests.
      deny: [
        '.env', '.env.*', '**/.env*', '*.{crt,pem,key}',
        '**/.git/**', '**/.codex/**', '**/.agents/**', '**/.entire/**',
        '**/server/**', '**/data/**', '**/.data/**', '**/tests/**',
      ],
    },
  },
  build: { outDir: 'dist/client' },
});
