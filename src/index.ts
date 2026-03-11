/**
 * capacitor-mobile-claw — On-device AI agent engine for Capacitor apps.
 *
 * Usage:
 *   import { MobileClaw } from 'capacitor-mobile-claw'
 *
 *   const engine = MobileClawEngine.getInstance()
 *   await engine.init()
 *
 *   engine.on('agentEvent', (e) => {
 *     if (e.eventType === 'text_delta') process.stdout.write(e.data.text)
 *   })
 *
 *   const { sessionKey } = await engine.sendMessage({ prompt: 'Hello!' })
 */

import { registerPlugin } from '@capacitor/core'
import type { MobileClawPlugin } from './definitions'

const MobileClaw = registerPlugin<MobileClawPlugin>('MobileClaw', {
  web: () => import('./plugin').then((m) => new m.MobileClawWeb()),
})

export * from './definitions'
export { MobileClaw }

export { ResourceQuotaTracker } from './agent/resource-quotas'
// Export engine for direct use (framework wrappers, testing)
export { MobileClawEngine } from './engine'
export { McpServerManager } from './mcp/mcp-server-manager'

// DeviceTool interface — the contract for external tool packages
export type { DeviceTool } from './mcp/tools/types'
