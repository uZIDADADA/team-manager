import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const apiTarget = process.env.TEAMMGR_DEV_API_TARGET;

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      allowedHosts: [],
      ...(apiTarget
        ? {
            proxy: {
              '/api': apiTarget,
              '/public': apiTarget,
              '/health': apiTarget
            }
          }
        : {})
    },
    build: {
      outDir: 'dist'
    }
  };
});
