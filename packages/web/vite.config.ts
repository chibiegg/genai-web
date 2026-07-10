import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    // リバースプロキシ経由で独自ドメインから開発サーバへアクセスする場合に
    // 許可するホスト名（カンマ区切り）。例: VITE_ALLOWED_HOSTS=demo.example.com
    ...(process.env.VITE_ALLOWED_HOSTS
      ? { allowedHosts: process.env.VITE_ALLOWED_HOSTS.split(',') }
      : {}),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      './runtimeConfig': './runtimeConfig.browser',
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
});
