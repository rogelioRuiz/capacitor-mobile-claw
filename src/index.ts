/**
 * capacitor-mobile-claw — On-device AI agent engine for Capacitor apps.
 *
 * Usage:
 *   import { MobileClaw } from 'capacitor-mobile-claw'
 *
 *   const info = await MobileClaw.init()
 *   console.log(`Worker ready: Node ${info.nodeVersion}, ${info.mcpToolCount} tools`)
 *
 *   MobileClaw.addListener('agentEvent', (e) => {
 *     if (e.eventType === 'text_delta') process.stdout.write(e.data.text)
 *   })
 *
 *   const { sessionKey } = await MobileClaw.sendMessage({ prompt: 'Hello!' })
 */

import { registerPlugin } from '@capacitor/core'
import type { MobileClawPlugin } from './definitions'

const MobileClaw = registerPlugin<MobileClawPlugin>('MobileClaw', {
  web: () => import('./plugin').then((m) => new m.MobileClawWeb()),
})

export * from './definitions'
export { MobileClaw }

export type { AgentRunnerConfig, AgentRunParams, PreExecuteResult } from './agent/agent-runner'
// WebView agent components — for consumers that need direct access
export { AgentRunner } from './agent/agent-runner'
export { SessionStore } from './agent/session-store'
export { ToolProxy } from './agent/tool-proxy'
export { TOOL_SCHEMAS } from './agent/tool-schemas'
// Export engine for direct use (framework wrappers, testing)
export { MobileClawEngine } from './engine'
export { McpServerManager } from './mcp/mcp-server-manager'

// DeviceTool interface — the contract for external tool packages
export type { DeviceTool } from './mcp/tools/types'

// Re-export bridge protocol types for consumers building custom integrations
export type {
  AgentCompletedMessage,
  AgentErrorMessage,
  AgentEventMessage,
  AgentStartMessage,
  AgentStopMessage,
  NodeToUIMessage,
  ReadyMessage,
  ToolPreExecuteExpiredMessage,
  ToolPreExecuteMessage,
  ToolPreExecuteResultMessage,
  UIToNodeMessage,
} from './services/bridge-protocol'
