/**
 * MobileClaw Capacitor Plugin — Public API definitions.
 *
 * This is a headless (no-UI) plugin that embeds an AI agent engine
 * on-device via Capacitor-NodeJS. The agent has file tools, code
 * execution, git integration, and 64+ MCP device tools.
 *
 * Tool approval policy is NOT handled by this plugin — the consumer
 * controls policy via tool middleware or the legacy pre-execution hook.
 *
 * Usage:
 *   import { MobileClaw } from 'capacitor-mobile-claw'
 *
 *   await MobileClaw.init()
 *   const key = await MobileClaw.sendMessage('Hello agent')
 *   MobileClaw.onEvent('text_delta', (e) => console.log(e.text))
 */

// ── Core plugin interface ──────────────────────────────────────────────────

export interface MobileClawPlugin {
  /**
   * Initialize the embedded Node.js worker and MCP bridge.
   * Must be called once before any other method.
   * Resolves when the worker sends 'worker.ready'.
   */
  init(options?: MobileClawInitOptions): Promise<MobileClawReadyInfo>

  /**
   * Whether the plugin has been initialized and the worker is ready.
   */
  isReady(): Promise<{ ready: boolean }>

  // ── Agent control ────────────────────────────────────────────────────

  /**
   * Send a prompt to the agent. Returns the session key for this conversation.
   * Reuses the current session key for multi-turn conversations.
   */
  sendMessage(options: { prompt: string; agentId?: string }): Promise<{ sessionKey: string }>

  /**
   * Stop the currently running agent turn.
   */
  stopTurn(): Promise<void>

  /**
   * Send a steering/follow-up message to a running agent turn.
   */
  steerAgent(options: { text: string }): Promise<void>

  // ── Configuration ────────────────────────────────────────────────────

  /**
   * Update worker configuration (e.g. set API key, provider, model).
   */
  updateConfig(options: { config: Record<string, unknown> }): Promise<void>

  /**
   * Get auth profile status from the worker.
   */
  getAuthStatus(): Promise<AuthStatus>

  // ── Scheduler / heartbeat / cron ────────────────────────────────────

  /**
   * Update scheduler config.
   */
  setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void>

  /**
   * Read scheduler + heartbeat config.
   */
  getSchedulerConfig(): Promise<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }>

  /**
   * Update heartbeat config.
   */
  setHeartbeat(config: Partial<HeartbeatConfig>): Promise<void>

  /**
   * Trigger an immediate heartbeat wake.
   */
  triggerHeartbeatWake(source?: string): Promise<void>

  /**
   * Add/update/remove/list cron jobs and runs.
   */
  addCronJob(job: CronJobInput): Promise<CronJobRecord>
  updateCronJob(id: string, patch: Partial<CronJobInput>): Promise<void>
  removeCronJob(id: string): Promise<void>
  listCronJobs(): Promise<CronJobRecord[]>
  runCronJob(id: string): Promise<void>
  getCronRunHistory(jobId?: string, limit?: number): Promise<CronRunRecord[]>

  /**
   * Add/update/remove/list cron skills.
   */
  addSkill(skill: CronSkillInput): Promise<CronSkillRecord>
  updateSkill(id: string, patch: Partial<CronSkillInput>): Promise<void>
  removeSkill(id: string): Promise<void>
  listSkills(): Promise<CronSkillRecord[]>

  // ── File operations ──────────────────────────────────────────────────

  /**
   * Read a file from the agent workspace.
   */
  readFile(options: { path: string }): Promise<FileReadResult>

  /**
   * Write a file to the agent workspace.
   */
  writeFile(options: { path: string; content: string }): Promise<void>

  // ── Session management ───────────────────────────────────────────────

  /**
   * List past sessions from the worker's JSONL store.
   */
  listSessions(options?: { agentId?: string }): Promise<SessionListResult>

  /**
   * Get the most recent session.
   */
  getLatestSession(options?: { agentId?: string }): Promise<SessionInfo | null>

  /**
   * Load message history for a session from JSONL transcript.
   */
  loadSessionHistory(options: { sessionKey: string; agentId?: string }): Promise<SessionHistoryResult>

  /**
   * Resume a previous session (hydrate agent with saved messages).
   */
  resumeSession(options: { sessionKey: string; agentId?: string }): Promise<void>

  /**
   * Clear the current conversation (local state; transcripts preserved).
   */
  clearConversation(): Promise<{ success: boolean }>

  /**
   * Set the current session key (e.g. for resuming a specific session).
   */
  setSessionKey(options: { sessionKey: string }): Promise<void>

  /**
   * Get the current session key.
   */
  getSessionKey(): Promise<{ sessionKey: string | null }>

  // ── Tool invocation (direct, without agent) ──────────────────────────

  /**
   * Invoke a worker tool directly (local file tools or MCP device tools).
   * Useful for testing or for direct tool access without running the agent.
   */
  invokeTool(options: { toolName: string; args?: Record<string, unknown> }): Promise<ToolInvokeResult>

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * Register a listener for agent events.
   * Returns an unsubscribe function.
   */
  addListener(
    eventName: MobileClawEventName,
    handler: (event: MobileClawEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>

  /**
   * Remove all listeners for an event type.
   */
  removeAllListeners(eventName?: MobileClawEventName): Promise<void>
}

// ── Init options ───────────────────────────────────────────────────────────

import type { DeviceTool } from './mcp/tools/types'

export interface ToolMiddlewareContext {
  name: string
  toolCallId: string
  args: Record<string, unknown>
}

export type ToolMiddleware = (
  tool: ToolMiddlewareContext,
  execute: (args?: Record<string, unknown>) => Promise<any>,
  signal?: AbortSignal,
) => Promise<any>

export interface MobileClawInitOptions {
  /** Enable STOMP MCP transport (remote access). Default: false. */
  enableStomp?: boolean
  /** Custom STOMP config when enableStomp is true. */
  stompConfig?: StompConfig
  /** MCP device tools to register. Pass from an external tools package. */
  tools?: DeviceTool[]
  /** Pre-imported MobileCron plugin instance. Avoids dynamic import issues in Capacitor WebView. */
  mobileCron?: any
  /**
   * Run the AI agent loop directly in the WebView instead of the Node.js worker.
   * Eliminates worker cold start latency — the agent is available immediately.
   * Tools that need Node.js (file I/O, git, exec) are proxied to the worker.
   * Default: false (use worker-based agent).
   */
  useWebViewAgent?: boolean
  /**
   * Optional middleware that wraps tool execution end-to-end.
   * When provided, this owns approval, auditing, and any policy checks.
   */
  toolMiddleware?: ToolMiddleware
  /**
   * Consumer-owned policy: returns true if tool requires user approval.
   * Used by cron job middleware to forward approval requests to the main chat.
   */
  needsApproval?: (toolName: string) => boolean
}

export interface StompConfig {
  brokerURL: string
  login: string
  passcode: string
  deviceId?: string
  reconnectDelay?: number
}

// ── Ready info ─────────────────────────────────────────────────────────────

export interface MobileClawReadyInfo {
  nodeVersion: string
  openclawRoot: string
  mcpToolCount: number
}

// ── Auth ───────────────────────────────────────────────────────────────────

export interface AuthStatus {
  hasKey: boolean
  masked: string
}

// ── File operations ────────────────────────────────────────────────────────

export interface FileReadResult {
  path: string
  content: string
  error?: string
}

// ── Sessions ───────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionKey: string
  sessionId?: string
  updatedAt: number
  model?: string
  totalTokens?: number
}

export interface SessionListResult {
  agentId: string
  sessions: SessionInfo[]
}

export interface SessionHistoryResult {
  sessionKey: string
  messages: unknown[]
  error?: string
}

// ── Scheduler / heartbeat / cron ────────────────────────────────────────

export interface ActiveHours {
  start: string
  end: string
  tz?: string
}

export interface SchedulerConfig {
  enabled: boolean
  schedulingMode: 'eco' | 'balanced' | 'aggressive'
  runOnCharging: boolean
  globalActiveHours?: ActiveHours
}

export interface HeartbeatConfig {
  enabled: boolean
  everyMs: number
  prompt?: string
  skillId?: string
  activeHours?: ActiveHours
  nextRunAt?: number
  lastHash?: string
  lastSentAt?: number
}

export interface CronSkillInput {
  name: string
  allowedTools?: string[]
  systemPrompt?: string
  model?: string
  maxTurns?: number
  timeoutMs?: number
}

export interface CronSkillRecord extends CronSkillInput {
  id: string
  createdAt: number
  updatedAt: number
}

export interface CronJobInput {
  name: string
  enabled?: boolean
  sessionTarget?: 'isolated' | 'main'
  wakeMode?: 'now' | 'next-heartbeat'
  schedule: { kind: 'every' | 'at'; everyMs?: number; atMs?: number }
  skillId: string
  prompt: string
  deliveryMode?: 'notification' | 'webhook' | 'none'
  deliveryWebhookUrl?: string
  deliveryNotificationTitle?: string
  activeHours?: ActiveHours
}

export interface CronJobRecord extends CronJobInput {
  id: string
  lastRunAt?: number
  nextRunAt?: number
  lastRunStatus?: string
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors: number
  createdAt: number
  updatedAt: number
}

export interface CronRunRecord {
  id: number
  jobId: string
  startedAt: number
  endedAt?: number
  status: 'ok' | 'error' | 'skipped' | 'suppressed' | 'deduped'
  durationMs?: number
  error?: string
  responseText?: string
  wakeSource?: string
}

// ── Tool invocation ────────────────────────────────────────────────────────

export interface ToolInvokeResult {
  toolName: string
  result?: unknown
  error?: string
}

// ── Events ─────────────────────────────────────────────────────────────────

export type MobileClawEventName =
  | 'agentEvent'
  | 'agentCompleted'
  | 'agentError'
  | 'toolPreExecute'
  | 'toolPreExecuteExpired'
  | 'workerReady'
  | 'heartbeatStarted'
  | 'heartbeatCompleted'
  | 'heartbeatSkipped'
  | 'cronJobStarted'
  | 'cronJobCompleted'
  | 'cronJobError'
  | 'cronNotification'
  | 'schedulerStatus'
  | 'schedulerOverdue'

export type MobileClawEvent =
  | AgentEvent
  | AgentCompletedEvent
  | AgentErrorEvent
  | ToolPreExecuteEvent
  | ToolPreExecuteExpiredEvent
  | WorkerReadyEvent
  | HeartbeatStartedEvent
  | HeartbeatCompletedEvent
  | HeartbeatSkippedEvent
  | CronJobStartedEvent
  | CronJobCompletedEvent
  | CronJobErrorEvent
  | CronNotificationEvent
  | SchedulerStatusEvent
  | SchedulerOverdueEvent

export interface AgentEvent {
  eventType: 'text_delta' | 'tool_use' | 'tool_result' | 'thinking' | 'error'
  data: Record<string, unknown>
}

export interface AgentCompletedEvent {
  sessionKey: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  durationMs: number
}

export interface AgentErrorEvent {
  error: string
  code?: string
}

export interface ToolPreExecuteEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ToolPreExecuteExpiredEvent {
  toolCallId: string
  toolName: string
}

export interface WorkerReadyEvent {
  nodeVersion: string
  openclawRoot: string
  mcpToolCount?: number
}

export interface HeartbeatStartedEvent {
  source: string
}

export interface HeartbeatCompletedEvent {
  status: string
  reason?: string
  durationMs: number
  responsePreview?: string
}

export interface HeartbeatSkippedEvent {
  reason: string
}

export interface CronJobStartedEvent {
  jobId: string
  jobName: string
}

export interface CronJobCompletedEvent {
  jobId: string
  status: string
  durationMs: number
  responsePreview?: string
}

export interface CronJobErrorEvent {
  jobId: string
  error: string
  consecutiveErrors: number
}

export interface CronNotificationEvent {
  title: string
  body: string
  jobId?: string
  source: string
}

export interface SchedulerStatusEvent {
  enabled: boolean
  mode: string
  nextDueAt?: number
  heartbeatNext?: number
}

export interface SchedulerOverdueEvent {
  [key: string]: unknown
}
