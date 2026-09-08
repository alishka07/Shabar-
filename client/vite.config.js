import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Клиент и сервер живут на разных портах, но в браузере путь один и тот же
    // (/api/...), поэтому код синхронизации не знает про адрес сервера вообще.
    proxy: {
      '/api': {
        target: process.env.KHABAR_API || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
});
