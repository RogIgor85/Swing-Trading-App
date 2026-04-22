import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, proxy /api/* to a local Express-like handler.
// In production (Vercel), /api/* routes to the serverless functions automatically.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // If no local api server is running, requests fall through gracefully
        // (the scoring engine handles missing Yahoo Finance data with ⚠️ flags)
      },
    },
  },
})
