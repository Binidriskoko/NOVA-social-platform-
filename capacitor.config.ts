import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.novakoko.app',
  appName: 'novachat',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
