import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/resource-allocation/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: {
      '/api/resource-allocation/v1': {
        target: process.env.RESOURCE_ALLOCATION_API_TARGET ?? 'http://127.0.0.1:3003',
        changeOrigin: true,
      },
    },
  },
});
