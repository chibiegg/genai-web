import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// リバースプロキシ経由で独自ドメインからアクセスする場合に許可するホスト名。
// dev サーバ・preview サーバの双方に適用する（カンマ区切り）。
const allowedHosts = process.env.VITE_ALLOWED_HOSTS
  ? process.env.VITE_ALLOWED_HOSTS.split(',')
  : undefined;

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    ...(allowedHosts ? { allowedHosts } : {}),
  },
  preview: {
    ...(allowedHosts ? { allowedHosts } : {}),
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
