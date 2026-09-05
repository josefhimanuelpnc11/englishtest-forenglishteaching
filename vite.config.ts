import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation is REQUIRED for the
// multithreaded ONNX Runtime WASM binary, which
// needs SharedArrayBuffer. Without these headers
// (e.g. plain `vite dev` defaults), face detection
// fails at session creation time.
//
// COEP "credentialless" is used instead of
// "require-corp" so cross-origin no-cors requests
// (Google Apps Script result/violation logging)
// keep working while isolation stays enabled.
//
// The production host must send the same two
// headers, otherwise face detection will fail
// there too (this is a server-header requirement,
// not application code).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
})
