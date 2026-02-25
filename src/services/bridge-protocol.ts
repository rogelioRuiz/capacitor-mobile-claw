/**
 * Bridge protocol between the Web UI and the embedded Node.js worker.
 * Messages are JSON-serialized and passed via Capacitor-NodeJS message channel.
 */

// ── UI → Node.js ────────────────────────────────────────────────────────────

export interface AgentStartMessage {
  type: 'agent.start'
  agentId: string
  sessionKey: string
  prompt: string
  provider?: string
  model?: string
}

export interface AgentStopMessage {
  type: 'agent.stop'
}

export interface ToolApproveMessage {
  type: 'tool.approve'
  toolCallId: string
  approved: boolean
}

export interface AgentSteerMessage {
  type: 'agent.steer'
  text: string
}

export interface ConfigUpdateMessage {
  type: 'config.update'
  config: Record<string, unknown>
}

export interface SessionListMessage {
  type: 'session.list'
  agentId: string
}

export interface ConfigStatusMessage {
  type: 'config.status'
}

export interface SessionClearMessage {
  type: 'session.clear'
}

export interface FileReadMessage {
  type: 'file.read'
  path: string
}

export interface FileWriteMessage {
  type: 'file.write'
  path: string
  content: string
}

export interface SkillToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /** When true, the worker emits a bridge message with the tool input instead of returning a result */
  bridgeEvent?: string // e.g. 'setup.theme' — worker sends this message type to UI
}

export interface SkillStartMessage {
  type: 'skill.start'
  skill: string
  agentId?: string
  locale?: string // ISO 639-1: 'en', 'es', etc.
  /** Injected skill config — if provided, overrides worker defaults */
  config?: {
    systemPrompt: string
    milestones: string[]
    tools: SkillToolDef[]
    kickoff: string
  }
}

export type UIToNodeMessage =
  | AgentStartMessage
  | AgentStopMessage
  | ToolApproveMessage
  | AgentSteerMessage
  | ConfigUpdateMessage
  | ConfigStatusMessage
  | SessionListMessage
  | SessionClearMessage
  | FileReadMessage
  | FileWriteMessage
  | SkillStartMessage

// ── Node.js → UI ────────────────────────────────────────────────────────────

export interface AgentEventMessage {
  type: 'agent.event'
  eventType: 'text_delta' | 'tool_use' | 'tool_result' | 'thinking' | 'error'
  data: Record<string, unknown>
}

export interface AgentCompletedMessage {
  type: 'agent.completed'
  sessionKey: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  durationMs: number
}

export interface AgentErrorMessage {
  type: 'agent.error'
  error: string
  code?: string
}

export interface ToolApprovalRequestMessage {
  type: 'tool.approval_request'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ReadyMessage {
  type: 'worker.ready'
  nodeVersion: string
  openclawRoot: string
}

export interface SessionListResultMessage {
  type: 'session.list.result'
  agentId: string
  sessions: Array<{
    sessionKey: string
    sessionId: string
    updatedAt: number
    model?: string
    totalTokens?: number
  }>
}

export interface FileReadResultMessage {
  type: 'file.read.result'
  path: string
  content: string
  error?: string
}

export interface ConfigStatusResultMessage {
  type: 'config.status.result'
  hasKey: boolean
  masked: string
}

export interface SessionClearResultMessage {
  type: 'session.clear.result'
  success: boolean
}

export type NodeToUIMessage =
  | AgentEventMessage
  | AgentCompletedMessage
  | AgentErrorMessage
  | ToolApprovalRequestMessage
  | ReadyMessage
  | SessionListResultMessage
  | FileReadResultMessage
  | ConfigStatusResultMessage
  | SessionClearResultMessage
