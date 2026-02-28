import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { mobileClawVitePlugin } from 'capacitor-mobile-claw/vite-plugin'

export default defineConfig({
  plugins: [mobileClawVitePlugin(), vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Force Vite to resolve capacitor-mobilecron from this app's node_modules
      // instead of treating it as an optional peer dep stub
      'capacitor-mobilecron': resolve(__dirname, 'node_modules/capacitor-mobilecron'),
    },
    // Ensure file: deps (mobile-claw) resolve peer deps from this app's node_modules
    dedupe: ['@capacitor/core', 'capacitor-mobilecron'],
  },
})
