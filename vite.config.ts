import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5174,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        // index = 라이브러리 (메인 진입), filmmaker = 컷씬 에디터
        main: 'index.html',
        filmmaker: 'filmmaker.html',
      },
    },
  },
});
