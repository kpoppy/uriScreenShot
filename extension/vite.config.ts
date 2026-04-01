import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'content/capture': resolve(__dirname, 'src/content/capture.ts'),
        'content/selector': resolve(__dirname, 'src/content/selector.ts'),
        'popup/popup': resolve(__dirname, 'src/popup/popup.html'),
        'recorder/recorder': resolve(__dirname, 'src/recorder/recorder.html'),
        'editor/editor': resolve(__dirname, 'src/editor/editor.html'),
        'options/options': resolve(__dirname, 'src/options/options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return '[name][extname]'
          return 'assets/[name][extname]'
        },
      },
    },
  },
})
