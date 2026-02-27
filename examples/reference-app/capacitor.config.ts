import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.mobileclaw.reference',
  appName: 'Mobile Claw',
  webDir: 'dist',
  server: {
    iosScheme: 'capacitor',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 2000,
      backgroundColor: '#0d0d0d',
      showSpinner: true,
      spinnerColor: '#7c3aed',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0d0d0d',
    },
    Keyboard: {
      resize: 'none',
    },
    CapacitorNodeJS: {
      nodeDir: 'nodejs-project',
    },
  },
}

export default config
