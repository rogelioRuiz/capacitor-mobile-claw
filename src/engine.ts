/**
 * MobileClawEngine — Framework-agnostic core engine.
 *
 * This is the headless implementation of the MobileClaw plugin.
 * It manages the embedded Node.js worker, bridge communication,
 * MCP server lifecycle, and exposes all plugin API methods.
 *
 * Tool approval policy is NOT handled here — the consumer controls
 * policy via the pre-execution hook (tool.pre_execute events).
 *
 * No Vue, React, or any UI framework dependency.
 */

import { Capacitor } from '@capacitor/core'
import type {
  AuthStatus,
  CronJobInput,
  CronJobRecord,
  CronRunRecord,
  CronSkillInput,
  CronSkillRecord,
  FileReadResult,
  HeartbeatConfig,
  MobileClawEvent,
  MobileClawEventName,
  MobileClawInitOptions,
  MobileClawReadyInfo,
  SchedulerConfig,
  SessionHistoryResult,
  SessionInfo,
  SessionListResult,
  ToolInvokeResult,
} from './definitions'
import { McpServerManager, type McpServerOptions } from './mcp/mcp-server-manager'

type MessageHandler = (msg: any) => void

export class MobileClawEngine {
  // ── State ──────────────────────────────────────────────────────────────

  private _ready = false
  private _available = false
  private _nodeVersion: string | null = null
  private _openclawRoot: string | null = null
  private _mcpToolCount = 0
  private _loading = false
  private _error: string | null = null
  private _currentSessionKey: string | null = null
  private _loadingPhase: string = 'starting'

  private nodePlugin: any = null
  private listeners = new Map<string, Set<MessageHandler>>()
  private initPromise: Promise<MobileClawReadyInfo> | null = null
  private _mcpManager: McpServerManager | null = null
  private _mobileCron: any = null

  // ── Public getters ─────────────────────────────────────────────────────

  get ready(): boolean {
    return this._ready
  }
  get available(): boolean {
    return this._available
  }
  get nodeVersion(): string | null {
    return this._nodeVersion
  }
  get openclawRoot(): string | null {
    return this._openclawRoot
  }
  get mcpToolCount(): number {
    return this._mcpToolCount
  }
  get loading(): boolean {
    return this._loading
  }
  get error(): string | null {
    return this._error
  }
  get currentSessionKey(): string | null {
    return this._currentSessionKey
  }
  get loadingPhase(): string {
    return this._loadingPhase
  }

  /** Access the MCP server manager for status, restart, etc. */
  get mcpManager(): McpServerManager | null {
    return this._mcpManager
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async init(options: MobileClawInitOptions = {}): Promise<MobileClawReadyInfo> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit(options)
    return this.initPromise
  }

  private async _doInit(options: MobileClawInitOptions): Promise<MobileClawReadyInfo> {
    if (!Capacitor.isNativePlatform()) {
      this._available = false
      this._error = 'MobileClaw only works on native platforms (Android/iOS)'
      return { nodeVersion: '', openclawRoot: '', mcpToolCount: 0 }
    }

    this._loading = true
    this._error = null

    try {
      const { NodeJS } = await import('@choreruiz/capacitor-node-js')
      this.nodePlugin = NodeJS
      this._available = true

      // Register message listener FIRST — the worker may have already
      // emitted worker.ready before MCP init completes.
      this.nodePlugin.addListener('message', (event: any) => {
        const msg = event?.args?.[0] ?? event
        if (!msg || !msg.type) return
        this._dispatch(msg)
      })

      this._onMessage('worker.tools_updated', (msg) => {
        if (msg?.mcpToolCount == null) return
        this._mcpToolCount = msg.mcpToolCount
        console.log(`[MobileClaw] Tools updated — ${this._mcpToolCount} MCP tools`)
      })

      this._onMessage('worker.loading_phase', (msg) => {
        if (msg?.phase) this._loadingPhase = msg.phase
      })

      // Set up worker.ready promise before MCP init (captures early ready events)
      const timeout = options.workerTimeout ?? 60_000
      const readyPromise = new Promise<MobileClawReadyInfo>((resolve) => {
        const timer = setTimeout(() => {
          this._error = `Worker startup timeout (${timeout}ms)`
          this._loading = false
          resolve({ nodeVersion: '', openclawRoot: '', mcpToolCount: this._mcpToolCount })
        }, timeout)

        this._onMessage(
          'worker.ready',
          (msg) => {
            clearTimeout(timer)
            this._ready = true
            this._nodeVersion = msg.nodeVersion
            this._openclawRoot = msg.openclawRoot
            this._mcpToolCount = msg.mcpToolCount ?? this._mcpToolCount
            this._loading = false
            this._error = null
            resolve({
              nodeVersion: msg.nodeVersion,
              openclawRoot: msg.openclawRoot,
              mcpToolCount: this._mcpToolCount,
            })
          },
          { once: true },
        )
      })

      // Start MCP bridge (worker calls tools/list during init)
      try {
        this._mcpManager = new McpServerManager()
        const mcpOpts: McpServerOptions = {
          enableBridge: options.enableBridge !== false,
          enableStomp: options.enableStomp ?? false,
          stompConfig: options.stompConfig,
          tools: options.tools,
        }
        await this._mcpManager.start(mcpOpts)
        this._mcpToolCount = this._mcpManager.toolCount
        console.log(`[MobileClaw] MCP server started — ${this._mcpToolCount} tools`)
      } catch (mcpErr) {
        console.warn('[MobileClaw] MCP bridge start failed (non-fatal):', mcpErr)
      }

      const readyInfo = await readyPromise

      await this._initMobileCron().catch((err) => {
        console.warn('[MobileClaw] MobileCron init failed (non-fatal):', err)
      })

      return readyInfo
    } catch (e: any) {
      this._available = false
      this._error = `Capacitor-NodeJS not available: ${e.message}`
      this._loading = false
      return { nodeVersion: '', openclawRoot: '', mcpToolCount: 0 }
    }
  }

  private async _initMobileCron(): Promise<void> {
    let MobileCron: any
    try {
      const mod = await import('capacitor-mobilecron')
      MobileCron = mod.MobileCron
      this._mobileCron = MobileCron
    } catch {
      return
    }

    const schedulerConfig = await this.getSchedulerConfig()
    if (schedulerConfig.scheduler.enabled) {
      await MobileCron.register({
        name: 'sentinel-heartbeat',
        schedule: {
          kind: 'every',
          everyMs: schedulerConfig.heartbeat.everyMs || 1_800_000,
        },
        activeHours: schedulerConfig.heartbeat.activeHours,
        priority: 'normal',
        requiresNetwork: true,
      })
      await MobileCron.setMode({
        mode: schedulerConfig.scheduler.schedulingMode,
      })
    }

    MobileCron.addListener('jobDue', (event: any) => {
      this.send({
        type: 'heartbeat.wake',
        source: event?.source || 'mobilecron',
        timestamp: event?.firedAt ?? Date.now(),
      }).catch(() => {})
    })

    // Android WorkManager fires 'nativeWake' (not 'jobDue') for background wakes.
    // The native CronWorker IS the sentinel timer on Android — relay it as heartbeat.wake.
    MobileCron.addListener('nativeWake', (event: any) => {
      this.send({
        type: 'heartbeat.wake',
        source: event?.source || 'workmanager',
        timestamp: Date.now(),
      }).catch(() => {})
    })

    MobileCron.addListener('overdueJobs', (event: any) => {
      this._dispatch({ type: 'scheduler.overdue', ...event })
      this.send({
        type: 'heartbeat.wake',
        source: 'foreground',
        timestamp: Date.now(),
      }).catch(() => {})
    })

    this._onMessage('scheduler.status', (msg) => {
      if (!this._mobileCron) return
      this._mobileCron.setMode({ mode: msg.mode }).catch(() => {})
    })
  }

  async isReady(): Promise<{ ready: boolean }> {
    return { ready: this._ready }
  }

  // ── Bridge communication ───────────────────────────────────────────────

  async send(message: Record<string, unknown>): Promise<void> {
    if (!this.nodePlugin) {
      console.warn('[MobileClaw] Cannot send — plugin not loaded')
      return
    }
    await this.nodePlugin.send({ eventName: 'message', args: [message] })
  }

  private async _waitForMessage<T>(type: string, request?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve) => {
      this._onMessage(type, (msg) => resolve(msg as T), { once: true })
      if (request) {
        this.send(request).catch((err) => {
          console.warn(`[MobileClaw] send failed for ${type}:`, err)
        })
      }
    })
  }

  /** Internal message listener (returns unsubscribe fn) */
  private _onMessage(type: string, handler: MessageHandler, opts: { once?: boolean } = {}): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    const wrapped = opts.once
      ? (msg: any) => {
          this.listeners.get(type)?.delete(wrapped)
          handler(msg)
        }
      : handler
    this.listeners.get(type)?.add(wrapped)
    return () => this.listeners.get(type)?.delete(wrapped)
  }

  private _dispatch(msg: any): void {
    // Type-specific handlers
    const handlers = this.listeners.get(msg.type)
    if (handlers) {
      for (const h of handlers) {
        try {
          h(msg)
        } catch (e) {
          console.error('[MobileClaw] handler error:', e)
        }
      }
    }
    // Wildcard handlers
    const wildcards = this.listeners.get('*')
    if (wildcards) {
      for (const h of wildcards) {
        try {
          h(msg)
        } catch (e) {
          console.error('[MobileClaw] wildcard error:', e)
        }
      }
    }
  }

  // ── Agent control ──────────────────────────────────────────────────────

  async sendMessage(prompt: string, agentId = 'main', options?: { model?: string }): Promise<{ sessionKey: string }> {
    if (!this._currentSessionKey) {
      this._currentSessionKey = `session-${Date.now()}`
    }
    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    await this.send({
      type: 'agent.start',
      agentId,
      sessionKey: this._currentSessionKey,
      prompt,
      ...(options?.model && { model: options.model }),
      idempotencyKey,
    })
    return { sessionKey: this._currentSessionKey }
  }

  async getModels(): Promise<Array<{ id: string; name: string; description: string; default?: boolean }>> {
    return new Promise((resolve) => {
      this._onMessage('config.models.result', (msg) => resolve(msg.models || []), { once: true })
      this.send({ type: 'config.models' })
    })
  }

  async stopTurn(): Promise<void> {
    await this.send({ type: 'agent.stop' })
  }

  /**
   * Respond to a pre-execution hook event.
   * The consumer calls this to allow, deny, or transform tool arguments.
   */
  async respondToPreExecute(
    toolCallId: string,
    args: Record<string, unknown>,
    deny?: boolean,
    denyReason?: string,
  ): Promise<void> {
    await this.send({
      type: 'tool.pre_execute.result',
      toolCallId,
      args,
      ...(deny && { deny }),
      ...(denyReason && { denyReason }),
    })
  }

  async steerAgent(text: string): Promise<void> {
    await this.send({ type: 'agent.steer', text })
  }

  // ── Configuration ──────────────────────────────────────────────────────

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    await this.send({ type: 'config.update', config })
  }

  async exchangeOAuthCode(tokenUrl: string, body: Record<string, string>, contentType?: string): Promise<any> {
    return new Promise((resolve) => {
      this._onMessage('oauth.exchange.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'oauth.exchange', tokenUrl, body, ...(contentType ? { contentType } : {}) })
    })
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return new Promise((resolve) => {
      this._onMessage('config.status.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'config.status' })
    })
  }

  // ── Scheduler / heartbeat / cron ─────────────────────────────────────

  async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('scheduler.set.result', {
      type: 'scheduler.set',
      config,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to set scheduler config')
    }
  }

  async getSchedulerConfig(): Promise<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }> {
    return this._waitForMessage<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }>('scheduler.get.result', {
      type: 'scheduler.get',
    })
  }

  async setHeartbeat(config: Partial<HeartbeatConfig>): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('heartbeat.set.result', {
      type: 'heartbeat.set',
      config,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to set heartbeat config')
    }
  }

  async triggerHeartbeatWake(source = 'manual'): Promise<void> {
    await this.send({ type: 'heartbeat.wake', source, timestamp: Date.now() })
  }

  async addCronJob(job: CronJobInput): Promise<CronJobRecord> {
    const result = await this._waitForMessage<{
      success: boolean
      job?: CronJobRecord
      error?: string
    }>('cron.job.add.result', { type: 'cron.job.add', job })
    if (!result.success || !result.job) {
      throw new Error(result.error || 'Failed to add cron job')
    }
    return result.job
  }

  async updateCronJob(id: string, patch: Partial<CronJobInput>): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('cron.job.update.result', {
      type: 'cron.job.update',
      id,
      patch,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to update cron job')
    }
  }

  async removeCronJob(id: string): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('cron.job.remove.result', {
      type: 'cron.job.remove',
      id,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to remove cron job')
    }
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    const result = await this._waitForMessage<{ jobs: CronJobRecord[] }>('cron.job.list.result', {
      type: 'cron.job.list',
    })
    return result.jobs || []
  }

  async runCronJob(id: string): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('cron.job.run.result', {
      type: 'cron.job.run',
      id,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to run cron job')
    }
  }

  async getCronRunHistory(jobId?: string, limit = 50): Promise<CronRunRecord[]> {
    const result = await this._waitForMessage<{ runs: CronRunRecord[] }>('cron.runs.list.result', {
      type: 'cron.runs.list',
      ...(jobId ? { jobId } : {}),
      limit,
    })
    return result.runs || []
  }

  async addSkill(skill: CronSkillInput): Promise<CronSkillRecord> {
    const result = await this._waitForMessage<{
      success: boolean
      skill?: CronSkillRecord
      error?: string
    }>('cron.skill.add.result', { type: 'cron.skill.add', skill })
    if (!result.success || !result.skill) {
      throw new Error(result.error || 'Failed to add skill')
    }
    return result.skill
  }

  async updateSkill(id: string, patch: Partial<CronSkillInput>): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('cron.skill.update.result', {
      type: 'cron.skill.update',
      id,
      patch,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to update skill')
    }
  }

  async removeSkill(id: string): Promise<void> {
    const result = await this._waitForMessage<{ success: boolean; error?: string }>('cron.skill.remove.result', {
      type: 'cron.skill.remove',
      id,
    })
    if (!result.success) {
      throw new Error(result.error || 'Failed to remove skill')
    }
  }

  async listSkills(): Promise<CronSkillRecord[]> {
    const result = await this._waitForMessage<{ skills: CronSkillRecord[] }>('cron.skill.list.result', {
      type: 'cron.skill.list',
    })
    return result.skills || []
  }

  // ── File operations ────────────────────────────────────────────────────

  async readFile(path: string): Promise<FileReadResult> {
    return new Promise((resolve) => {
      this._onMessage(
        'file.read.result',
        (msg) => {
          if (msg.path === path) resolve(msg)
        },
        { once: true },
      )
      this.send({ type: 'file.read', path })
    })
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.send({ type: 'file.write', path, content })
  }

  // ── Session management ─────────────────────────────────────────────────

  async listSessions(agentId = 'main'): Promise<SessionListResult> {
    return new Promise((resolve) => {
      this._onMessage('session.list.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'session.list', agentId })
    })
  }

  async getLatestSession(agentId = 'main'): Promise<SessionInfo | null> {
    return new Promise((resolve) => {
      this._onMessage('session.latest.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'session.latest', agentId })
    })
  }

  async loadSessionHistory(sessionKey: string, agentId = 'main'): Promise<SessionHistoryResult> {
    return new Promise((resolve) => {
      this._onMessage('session.load.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'session.load', sessionKey, agentId })
    })
  }

  async resumeSession(sessionKey: string, agentId = 'main'): Promise<void> {
    return new Promise((resolve) => {
      this._onMessage('session.resume.result', () => resolve(), { once: true })
      this.send({ type: 'session.resume', sessionKey, agentId })
    })
  }

  async clearConversation(): Promise<{ success: boolean }> {
    this._currentSessionKey = null
    return new Promise((resolve) => {
      this._onMessage('session.clear.result', (msg) => resolve(msg), { once: true })
      this.send({ type: 'session.clear' })
    })
  }

  async setSessionKey(sessionKey: string): Promise<void> {
    this._currentSessionKey = sessionKey
  }

  async getSessionKey(): Promise<{ sessionKey: string | null }> {
    return { sessionKey: this._currentSessionKey }
  }

  // ── Tool invocation ────────────────────────────────────────────────────

  async invokeTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolInvokeResult> {
    return new Promise((resolve) => {
      this._onMessage(
        'tool.invoke.result',
        (msg) => {
          if (msg.toolName === toolName) resolve(msg)
        },
        { once: true },
      )
      this.send({ type: 'tool.invoke', toolName, args })
    })
  }

  // ── Events (Capacitor plugin pattern) ──────────────────────────────────

  /**
   * Map from Capacitor event names to bridge message types.
   */
  private static readonly EVENT_MAP: Record<MobileClawEventName, string> = {
    agentEvent: 'agent.event',
    agentCompleted: 'agent.completed',
    agentError: 'agent.error',
    toolPreExecute: 'tool.pre_execute',
    toolPreExecuteExpired: 'tool.pre_execute.expired',
    workerReady: 'worker.ready',
    heartbeatStarted: 'heartbeat.started',
    heartbeatCompleted: 'heartbeat.completed',
    heartbeatSkipped: 'heartbeat.skipped',
    cronJobStarted: 'cron.job.started',
    cronJobCompleted: 'cron.job.completed',
    cronJobError: 'cron.job.error',
    cronNotification: 'cron.notification',
    schedulerStatus: 'scheduler.status',
    schedulerOverdue: 'scheduler.overdue',
  }

  addListener(eventName: MobileClawEventName, handler: (event: MobileClawEvent) => void): { remove: () => void } {
    const bridgeType = MobileClawEngine.EVENT_MAP[eventName]
    if (!bridgeType) {
      console.warn(`[MobileClaw] Unknown event: ${eventName}`)
      return { remove: () => {} }
    }
    const unsub = this._onMessage(bridgeType, handler)
    return { remove: unsub }
  }

  removeAllListeners(eventName?: MobileClawEventName): void {
    if (eventName) {
      const bridgeType = MobileClawEngine.EVENT_MAP[eventName]
      if (bridgeType) {
        this.listeners.delete(bridgeType)
      }
    } else {
      this.listeners.clear()
    }
  }

  // ── Low-level message listener (for advanced use / framework wrappers) ─

  /**
   * Register a handler for a specific bridge message type.
   * Useful for framework wrappers (Vue, React) that need raw bridge access.
   */
  onMessage(type: string, handler: MessageHandler, opts?: { once?: boolean }): () => void {
    return this._onMessage(type, handler, opts)
  }
}
