import { defineConfig } from 'vite'

// localhost is a secure context, which getUserMedia and the Origin Private File System require.
export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022' },
})
