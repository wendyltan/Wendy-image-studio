import { sites } from '@openai/sites-vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [vinext(), sites()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    watch: { useFsEvents: false, usePolling: true },
    proxy: { '/api': 'http://127.0.0.1:4318', '/media': 'http://127.0.0.1:4318' } },
});
