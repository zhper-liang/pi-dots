import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'PIDOT_API_PORT')
  const port = process.env.PIDOT_API_PORT || env.PIDOT_API_PORT || '3001'
  return {
  server: { host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${port}` } },
  preview: { host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${port}` } },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  }
})
