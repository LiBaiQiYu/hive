import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 组件库单独成块：它的版本很少变，缓存收益比塞进主包高
        manualChunks: {
          naive: ['naive-ui'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // 本地开发时把 /api 代理到 wrangler dev，前端就能用同源请求和真实 Cookie
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
