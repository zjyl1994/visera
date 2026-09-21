import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/yet-another-react-lightbox/')) return 'lightbox'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/') || id.includes('/@mui/') || id.includes('/@emotion/')) return 'vendor-framework'
          if (id.includes('/@tanstack/') || id.includes('/react-router')) return 'vendor-routing'
        },
      },
    },
  },
})
