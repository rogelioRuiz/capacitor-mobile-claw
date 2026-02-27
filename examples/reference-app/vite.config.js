import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    // Ensure file: deps (mobile-claw) resolve peer deps from this app's node_modules
    dedupe: ['@capacitor/core'],
  },
})
