/**
 * Bridge protocol between the Web UI and the embedded Node.js worker.
 * Messages are JSON-serialized and passed via Capacitor-NodeJS message channel.
 */

import type {
  CronJobInput,
  CronJobRecord,
  CronRunRecord,
  CronSkillInput,
  CronSkillRecord,
  HeartbeatConfig,
  SchedulerConfig,
} from '../definitions'

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

// ── Pre-execution hook (UI → Node.js) ─────────────────────────────────────

/**
 * Consumer responds to a pre-execution hook with (optionally transformed) args.
 * The worker will use these args for the actual tool execution.
 *
 * Set `deny: true` to cancel the tool execution entirely (e.g. approval denied,
 * biometric auth failed, or any policy-based rejection).
 */
export interface ToolPreExecuteResultMessage {
  type: 'tool.pre_execute.result'
  toolCallId: string
  args: Record<string, unknown>
  deny?: boolean
  denyReason?: string
}

// ── Tool execution proxy (UI → Node.js) ─────────────────────────────────

/**
 * WebView-side agent runner sends a tool call to the worker for execution.
 * The worker dispatches to the appropriate tool function (fs, git, vm, etc.)
 * and responds with `tool.execute.result`.
 */
export interface ToolExecuteMessage {
  type: 'tool.execute'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

// ── Auth token request (UI → Node.js) ───────────────────────────────────

/**
 * WebView-side agent runner requests auth credentials from the worker
 * (which manages auth-profiles.json on the filesystem).
 */
export interface AuthGetTokenMessage {
  type: 'auth.getToken'
  provider: string
  agentId?: string
}

// ── System prompt request (UI → Node.js) ────────────────────────────────

/**
 * WebView-side agent runner requests the system prompt from the worker
 * (which reads IDENTITY.md, SOUL.md, MEMORY.md from the workspace).
 */
export interface SystemPromptGetMessage {
  type: 'system_prompt.get'
  agentId?: string
}

export interface HeartbeatWakeMessage {
  type: 'heartbeat.wake'
  source?: string
  timestamp?: number
}

export interface HeartbeatSetMessage {
  type: 'heartbeat.set'
  config: Partial<HeartbeatConfig>
}

export interface SchedulerSetMessage {
  type: 'scheduler.set'
  config: Partial<SchedulerConfig>
}

export interface SchedulerGetMessage {
  type: 'scheduler.get'
}

export interface CronJobAddMessage {
  type: 'cron.job.add'
  job: CronJobInput
}

export interface CronJobUpdateMessage {
  type: 'cron.job.update'
  id: string
  patch: Partial<CronJobInput>
}

export interface CronJobRemoveMessage {
  type: 'cron.job.remove'
  id: string
}

export interface CronJobListMessage {
  type: 'cron.job.list'
}

export interface CronJobRunMessage {
  type: 'cron.job.run'
  id: string
}

export interface CronRunsListMessage {
  type: 'cron.runs.list'
  jobId?: string
  limit?: number
}

export interface CronSkillAddMessage {
  type: 'cron.skill.add'
  skill: CronSkillInput
}

export interface CronSkillUpdateMessage {
  type: 'cron.skill.update'
  id: string
  patch: Partial<CronSkillInput>
}

export interface CronSkillRemoveMessage {
  type: 'cron.skill.remove'
  id: string
}

export interface CronSkillListMessage {
  type: 'cron.skill.list'
}

export type UIToNodeMessage =
  | AgentStartMessage
  | AgentStopMessage
  | AgentSteerMessage
  | ConfigUpdateMessage
  | ConfigStatusMessage
  | SessionListMessage
  | SessionClearMessage
  | FileReadMessage
  | FileWriteMessage
  | SkillStartMessage
  | ToolPreExecuteResultMessage
  | ToolExecuteMessage
  | AuthGetTokenMessage
  | SystemPromptGetMessage
  | HeartbeatWakeMessage
  | HeartbeatSetMessage
  | SchedulerSetMessage
  | SchedulerGetMessage
  | CronJobAddMessage
  | CronJobUpdateMessage
  | CronJobRemoveMessage
  | CronJobListMessage
  | CronJobRunMessage
  | CronRunsListMessage
  | CronSkillAddMessage
  | CronSkillUpdateMessage
  | CronSkillRemoveMessage
  | CronSkillListMessage
  | DbJsonRpcResponseMessage

// ── DB Bridge (bidirectional JSON-RPC) ─────────────────────────────────────

export interface DbJsonRpcRequestMessage {
  type: 'db.jsonrpc'
  payload: {
    jsonrpc: '2.0'
    id: number
    method: 'db.init' | 'db.isReady' | 'db.run' | 'db.query' | 'db.queryOne' | 'db.transaction' | 'db.flush'
    params: Record<string, unknown>
  }
}

export interface DbJsonRpcResponseMessage {
  type: 'db.jsonrpc.response'
  payload: {
    jsonrpc: '2.0'
    id: number
    result?: unknown
    error?: { code: number; message: string }
  }
}

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

// ── Tool execution proxy response (Node.js → UI) ─────────────────────────

export interface ToolExecuteResultMessage {
  type: 'tool.execute.result'
  toolCallId: string
  toolName: string
  result?: unknown
  error?: string
}

// ── Auth token response (Node.js → UI) ───────────────────────────────────

export interface AuthGetTokenResultMessage {
  type: 'auth.getToken.result'
  apiKey: string | null
  isOAuth: boolean
}

// ── System prompt response (Node.js → UI) ────────────────────────────────

export interface SystemPromptGetResultMessage {
  type: 'system_prompt.get.result'
  systemPrompt: string
}

// ── Pre-execution hook (Node.js → UI) ─────────────────────────────────────

/**
 * Worker fires this before every tool execution, giving the consumer full
 * control over tool approval policy and argument transformation.
 *
 * The consumer MUST respond with `tool.pre_execute.result` to allow execution.
 * If no handler responds, the tool will be denied after the TTL expires
 * (safe-by-default).
 */
export interface ToolPreExecuteMessage {
  type: 'tool.pre_execute'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

/**
 * Worker notifies UI that a pre-execution hook timed out (2-min TTL).
 * The tool execution is cancelled.
 */
export interface ToolPreExecuteExpiredMessage {
  type: 'tool.pre_execute.expired'
  toolCallId: string
  toolName: string
}

export interface HeartbeatStartedMessage {
  type: 'heartbeat.started'
  source: string
}

export interface HeartbeatCompletedMessage {
  type: 'heartbeat.completed'
  status: string
  reason?: string
  durationMs: number
  responsePreview?: string
}

export interface HeartbeatSkippedMessage {
  type: 'heartbeat.skipped'
  reason: string
}

export interface CronJobStartedMessage {
  type: 'cron.job.started'
  jobId: string
  jobName: string
}

export interface CronJobCompletedMessage {
  type: 'cron.job.completed'
  jobId: string
  status: string
  durationMs: number
  responsePreview?: string
}

export interface CronJobErrorMessage {
  type: 'cron.job.error'
  jobId: string
  error: string
  consecutiveErrors: number
}

export interface CronNotificationMessage {
  type: 'cron.notification'
  title: string
  body: string
  jobId?: string
  source: string
}

export interface SchedulerStatusMessage {
  type: 'scheduler.status'
  enabled: boolean
  mode: string
  nextDueAt?: number
  heartbeatNext?: number
}

export interface SchedulerOverdueMessage {
  type: 'scheduler.overdue'
  [key: string]: unknown
}

export interface HeartbeatSetResultMessage {
  type: 'heartbeat.set.result'
  success: boolean
  heartbeat?: HeartbeatConfig
  error?: string
}

export interface SchedulerSetResultMessage {
  type: 'scheduler.set.result'
  success: boolean
  scheduler?: SchedulerConfig
  error?: string
}

export interface SchedulerGetResultMessage {
  type: 'scheduler.get.result'
  scheduler: SchedulerConfig
  heartbeat: HeartbeatConfig
}

export interface CronJobAddResultMessage {
  type: 'cron.job.add.result'
  success: boolean
  job?: CronJobRecord
  error?: string
}

export interface CronJobUpdateResultMessage {
  type: 'cron.job.update.result'
  success: boolean
  error?: string
}

export interface CronJobRemoveResultMessage {
  type: 'cron.job.remove.result'
  success: boolean
  error?: string
}

export interface CronJobListResultMessage {
  type: 'cron.job.list.result'
  jobs: CronJobRecord[]
}

export interface CronJobRunResultMessage {
  type: 'cron.job.run.result'
  success: boolean
  id: string
  error?: string
}

export interface CronRunsListResultMessage {
  type: 'cron.runs.list.result'
  runs: CronRunRecord[]
}

export interface CronSkillAddResultMessage {
  type: 'cron.skill.add.result'
  success: boolean
  skill?: CronSkillRecord
  error?: string
}

export interface CronSkillUpdateResultMessage {
  type: 'cron.skill.update.result'
  success: boolean
  error?: string
}

export interface CronSkillRemoveResultMessage {
  type: 'cron.skill.remove.result'
  success: boolean
  error?: string
}

export interface CronSkillListResultMessage {
  type: 'cron.skill.list.result'
  skills: CronSkillRecord[]
}

export type NodeToUIMessage =
  | AgentEventMessage
  | AgentCompletedMessage
  | AgentErrorMessage
  | ReadyMessage
  | SessionListResultMessage
  | FileReadResultMessage
  | ConfigStatusResultMessage
  | SessionClearResultMessage
  | ToolExecuteResultMessage
  | AuthGetTokenResultMessage
  | SystemPromptGetResultMessage
  | ToolPreExecuteMessage
  | ToolPreExecuteExpiredMessage
  | HeartbeatStartedMessage
  | HeartbeatCompletedMessage
  | HeartbeatSkippedMessage
  | CronJobStartedMessage
  | CronJobCompletedMessage
  | CronJobErrorMessage
  | CronNotificationMessage
  | SchedulerStatusMessage
  | SchedulerOverdueMessage
  | HeartbeatSetResultMessage
  | SchedulerSetResultMessage
  | SchedulerGetResultMessage
  | CronJobAddResultMessage
  | CronJobUpdateResultMessage
  | CronJobRemoveResultMessage
  | CronJobListResultMessage
  | CronJobRunResultMessage
  | CronRunsListResultMessage
  | CronSkillAddResultMessage
  | CronSkillUpdateResultMessage
  | CronSkillRemoveResultMessage
  | CronSkillListResultMessage
  | DbJsonRpcRequestMessage
