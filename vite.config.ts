import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  build: {
    emptyOutDir: true,
    // NOTE: Do NOT set rollupOptions.input here — @crxjs/vite-plugin
    // manages entry points from manifest.json itself. Setting rollupOptions.input
    // breaks the plugin's internal build pipeline.
  },
});
