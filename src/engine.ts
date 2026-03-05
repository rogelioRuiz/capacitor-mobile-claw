/**
 * MobileClawEngine — Framework-agnostic core engine.
 *
 * Runs entirely in the WebView. No Node.js worker dependency.
 * All tools (file I/O, git, code execution) run natively via
 * Capacitor plugins or WebAssembly.
 *
 * Tool policy is consumer-owned. Consumers can keep using the legacy
 * pre-execution hook or provide tool middleware that wraps execution.
 *
 * No Vue, React, or any UI framework dependency.
 */

import { Capacitor } from '@capacitor/core'
import { AgentRunner, type PreExecuteResult } from './agent/agent-runner'
import { getAuthStatus as getAuthStatusNative, getAuthToken, setAuthRoot } from './agent/auth-store'
import { CronDbAccess } from './agent/cron-db-access'
import { readFileNative, setWorkspaceRoot, writeFileNative } from './agent/file-tools'
import { setWorkspaceDir } from './agent/git-tools'
import { HeartbeatManager } from './agent/heartbeat-manager'
import { SessionStore } from './agent/session-store'
import { ToolProxy } from './agent/tool-proxy'
import { getModels as getModelsNative, initWorkspace, loadSystemPrompt } from './agent/workspace-init'
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
  ToolMiddleware,
} from './definitions'
import { McpServerManager, type McpServerOptions } from './mcp/mcp-server-manager'

type MessageHandler = (msg: any) => void
type AgentTool = import('@mariozechner/pi-agent-core').AgentTool<any>

export class MobileClawEngine {
  // ── State ──────────────────────────────────────────────────────────────

  private _ready = false
  private _available = false
  private _openclawRoot: string | null = null
  private _mcpToolCount = 0
  private _loading = false
  private _error: string | null = null
  private _currentSessionKey: string | null = null
  private _loadingPhase: string = 'starting'

  private listeners = new Map<string, Set<MessageHandler>>()
  private initPromise: Promise<MobileClawReadyInfo> | null = null
  private _mcpManager: McpServerManager | null = null
  private _mobileCron: any = null

  // ── Agent ──────────────────────────────────────────────────────────────
  private _agentRunner: AgentRunner | null = null
  private _toolProxy: ToolProxy | null = null
  private _sessionStore: SessionStore | null = null
  private _cronDb: CronDbAccess | null = null
  private _heartbeatManager: HeartbeatManager | null = null
  private _extraAgentTools: AgentTool[] = []
  private _toolMiddleware?: ToolMiddleware
  private _webViewFetchProxyInstalled = false
  /** Pending pre-execute resolvers keyed by toolCallId */
  private _preExecuteResolvers = new Map<string, (result: PreExecuteResult) => void>()

  // ── Public getters ─────────────────────────────────────────────────────

  get ready(): boolean {
    return this._ready
  }
  get available(): boolean {
    return this._available
  }
  /** @deprecated No Node.js worker — always returns null */
  get nodeVersion(): string | null {
    return null
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

  /** @deprecated Always true — the WebView agent is the only agent. */
  get useWebViewAgent(): boolean {
    return true
  }

  /** Access the agent runner. */
  get agentRunner(): AgentRunner | null {
    return this._agentRunner
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
    this._loadingPhase = 'initializing workspace'

    try {
      this._available = true

      // ── Workspace initialization (creates dirs + default files) ──────
      const { openclawRoot } = await initWorkspace()
      this._openclawRoot = openclawRoot

      // Configure native tools with workspace paths
      setWorkspaceRoot(`${openclawRoot}/workspace`)
      setWorkspaceDir(`/${openclawRoot}/workspace`)
      setAuthRoot(openclawRoot)

      this._loadingPhase = 'setting up agent'

      // ── Fetch proxy (native HTTP for CORS bypass) ───────────────────
      await this._installWebViewFetchProxy()

      // ── Tool proxy (all tools run natively now) ─────────────────────
      this._toolProxy = new ToolProxy()
      this._extraAgentTools = this._buildExtraAgentTools(options.tools)

      // ── Session store (SQLite) ──────────────────────────────────────
      this._sessionStore = new SessionStore()

      // ── Tool middleware ─────────────────────────────────────────────
      this._toolMiddleware = options.toolMiddleware

      // ── Agent runner ────────────────────────────────────────────────
      this._agentRunner = new AgentRunner({
        dispatch: (msg) => this._dispatch(msg),
        toolProxy: this._toolProxy,
        toolMiddleware: this._toolMiddleware,
        preExecuteHook: this._toolMiddleware
          ? undefined
          : (toolCallId, toolName, args, signal) => this._handlePreExecute(toolCallId, toolName, args, signal),
      })

      // Auto-save session to SQLite on agent completion
      this._onMessage('agent.completed', (msg) => {
        if (!this._sessionStore || !this._agentRunner?.currentAgent) return
        const agent = this._agentRunner.currentAgent
        const sessionKey = msg.sessionKey || this._currentSessionKey
        if (!sessionKey) return
        this._sessionStore
          .saveSession({
            sessionKey,
            agentId: 'main',
            messages: agent.state.messages as any[],
            model: msg.model,
            startTime: msg.durationMs ? Date.now() - msg.durationMs : Date.now(),
          })
          .catch((err: any) => {
            console.warn('[MobileClaw] Session save failed:', err?.message)
          })
      })

      // ── Cron / heartbeat ────────────────────────────────────────────
      this._cronDb = new CronDbAccess()
      this._heartbeatManager = new HeartbeatManager({
        dispatch: (msg) => this._dispatch(msg),
        toolProxy: this._toolProxy,
        cronDb: this._cronDb,
        getAuth: async (provider, _agentId) => getAuthToken(provider, _agentId),
        getSystemPrompt: async () => ({ systemPrompt: await loadSystemPrompt() }),
        isUserAgentRunning: () => this._agentRunner?.isRunning ?? false,
        getCurrentSessionKey: () => this._currentSessionKey,
        extraTools: this._extraAgentTools,
      })

      // ── MCP server ─────────────────────────────────────────────────
      this._loadingPhase = 'starting MCP'
      try {
        this._mcpManager = new McpServerManager()
        const mcpOpts: McpServerOptions = {
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

      // ── MobileCron ─────────────────────────────────────────────────
      await this._initMobileCron(options.mobileCron).catch((err) => {
        console.warn('[MobileClaw] MobileCron init failed (non-fatal):', err)
      })

      // ── Ready ──────────────────────────────────────────────────────
      this._ready = true
      this._loading = false
      this._loadingPhase = 'ready'
      this._error = null

      const readyInfo: MobileClawReadyInfo = {
        nodeVersion: '',
        openclawRoot,
        mcpToolCount: this._mcpToolCount,
      }

      // Emit worker.ready for backward compat with UI listeners
      this._dispatch({ type: 'worker.ready', ...readyInfo })

      return readyInfo
    } catch (e: any) {
      this._available = false
      this._error = `Initialization failed: ${e.message}`
      this._loading = false
      return { nodeVersion: '', openclawRoot: '', mcpToolCount: 0 }
    }
  }

  private async _initMobileCron(preloaded?: any): Promise<void> {
    let MobileCron: any
    if (preloaded) {
      MobileCron = preloaded
    } else {
      try {
        const mod = await import('capacitor-mobilecron')
        MobileCron = mod.MobileCron
      } catch {
        return
      }
    }
    // Vite stubs optional peer deps as empty objects -- bail if real plugin missing
    if (!MobileCron || typeof MobileCron.register !== 'function') return
    this._mobileCron = MobileCron

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
      if (this._heartbeatManager) {
        this._heartbeatManager.handleWake(event?.source || 'mobilecron').catch((err) => {
          console.warn('[MobileClaw] Heartbeat wake failed:', err?.message)
        })
      }
    })

    MobileCron.addListener('nativeWake', (event: any) => {
      if (this._heartbeatManager) {
        this._heartbeatManager.handleWake(event?.source || 'workmanager').catch((err) => {
          console.warn('[MobileClaw] Native wake failed:', err?.message)
        })
      }
    })

    MobileCron.addListener('overdueJobs', (event: any) => {
      this._dispatch({ type: 'scheduler.overdue', ...event })
      if (this._heartbeatManager) {
        this._heartbeatManager.handleWake('foreground').catch((err) => {
          console.warn('[MobileClaw] Foreground catch-up wake failed:', err?.message)
        })
      }
    })

    this._onMessage('scheduler.status', (msg) => {
      if (!this._mobileCron) return
      this._mobileCron.setMode({ mode: msg.mode }).catch(() => {})
    })
  }

  async isReady(): Promise<{ ready: boolean }> {
    return { ready: this._ready }
  }

  // ── Internal messaging (local dispatch only, no worker bridge) ──────

  /**
   * @deprecated No worker to send to. Use dispatchEvent() for local events.
   * Kept for backward compat — routes pre_execute results locally.
   */
  async send(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'tool.pre_execute.result') {
      const { toolCallId, args, deny, denyReason } = message as any
      return this.respondToPreExecute(
        toolCallId,
        args ?? {},
        deny as boolean | undefined,
        denyReason as string | undefined,
      )
    }
    // No worker to send to — dispatch locally for any listeners
    this._dispatch(message as any)
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

  async sendMessage(
    prompt: string,
    agentId = 'main',
    options?: { model?: string; provider?: string },
  ): Promise<{ sessionKey: string }> {
    if (!this._currentSessionKey) {
      this._currentSessionKey = `session-${Date.now()}`
    }

    const sessionKey = this._currentSessionKey

    if (this._agentRunner) {
      // Follow-up on existing conversation
      if (this._agentRunner.currentAgent && this._agentRunner.sessionKey === sessionKey) {
        this._agentRunner.followUp(prompt).catch((err) => {
          this._dispatch({ type: 'agent.error', error: err.message })
        })
        return { sessionKey }
      }

      // New session
      this._runAgent(prompt, agentId, sessionKey, options)
    }

    return { sessionKey }
  }

  /**
   * Start an agent run. Fetches auth + system prompt directly (no worker).
   */
  private async _runAgent(
    prompt: string,
    agentId: string,
    sessionKey: string,
    options?: { model?: string; provider?: string },
  ): Promise<void> {
    if (!this._agentRunner) return
    const provider = options?.provider || 'anthropic'

    try {
      const [authResult, systemPrompt] = await Promise.all([getAuthToken(provider, agentId), loadSystemPrompt()])

      if (!authResult.apiKey) {
        this._dispatch({
          type: 'agent.error',
          error: `No API key configured for provider "${provider}". Go to Settings to add one.`,
        })
        return
      }

      await this._agentRunner.run({
        prompt,
        agentId,
        sessionKey,
        model: options?.model,
        provider,
        apiKey: authResult.apiKey,
        systemPrompt,
        extraTools: this._extraAgentTools,
      })
    } catch (err: any) {
      this._dispatch({ type: 'agent.error', error: err.message || 'Agent failed' })
    }
  }

  private _buildExtraAgentTools(tools: MobileClawInitOptions['tools'] = []): AgentTool[] {
    return (tools || []).map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as any,
      execute: async (_toolCallId: string, args: Record<string, unknown>) => {
        try {
          const result = await tool.execute(args)
          const text = typeof result === 'string' ? result : JSON.stringify(result)
          return {
            content: [{ type: 'text' as const, text }],
            details: result,
          }
        } catch (err: any) {
          const message = err?.message || `Error executing ${tool.name}`
          return {
            content: [{ type: 'text' as const, text: `Error executing ${tool.name}: ${message}` }],
            details: { error: message },
          }
        }
      },
    }))
  }

  private async _installWebViewFetchProxy(): Promise<void> {
    if (this._webViewFetchProxyInstalled || typeof window === 'undefined') {
      return
    }

    if (!Capacitor.isNativePlatform()) {
      return
    }

    const { createProxiedFetch } = await import('./agent/fetch-proxy')
    window.fetch = createProxiedFetch()
    ;(window as any).__fetchProxied = true
    this._webViewFetchProxyInstalled = true
  }

  /**
   * Pre-execute hook: fires the event directly to UI listeners,
   * then waits for the consumer to respond via respondToPreExecute().
   */
  private _handlePreExecute(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PreExecuteResult> {
    return new Promise((resolve) => {
      const PRE_EXECUTE_TTL_MS = 120_000

      const timer = setTimeout(() => {
        this._preExecuteResolvers.delete(toolCallId)
        this._dispatch({ type: 'tool.pre_execute.expired', toolCallId, toolName })
        resolve({ deny: true, denyReason: 'pre_execute_timeout', args })
      }, PRE_EXECUTE_TTL_MS)

      this._preExecuteResolvers.set(toolCallId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            this._preExecuteResolvers.delete(toolCallId)
            resolve({ deny: true, denyReason: 'aborted', args })
          },
          { once: true },
        )
      }

      // Fire pre-execute event directly to UI listeners
      this._dispatch({ type: 'tool.pre_execute', toolCallId, toolName, args })
    })
  }

  async getModels(
    provider = 'anthropic',
  ): Promise<Array<{ id: string; name: string; description: string; default?: boolean }>> {
    return getModelsNative(provider)
  }

  async stopTurn(): Promise<void> {
    if (this._agentRunner) {
      this._agentRunner.abort()
    }
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
    const resolver = this._preExecuteResolvers.get(toolCallId)
    if (resolver) {
      this._preExecuteResolvers.delete(toolCallId)
      resolver({ deny: deny ?? false, denyReason, args })
    }
  }

  async steerAgent(text: string): Promise<void> {
    if (this._agentRunner) {
      this._agentRunner.steer(text)
    }
  }

  // ── Configuration ──────────────────────────────────────────────────────

  async updateConfig(_config: Record<string, unknown>): Promise<void> {
    // TODO: persist config changes to openclaw.json
  }

  async exchangeOAuthCode(tokenUrl: string, body: Record<string, string>, contentType?: string): Promise<any> {
    const { CapacitorHttp } = await import('@capacitor/core')
    const ct = contentType || 'application/json'
    try {
      const resp = await CapacitorHttp.request({
        method: 'POST',
        url: tokenUrl,
        headers: { 'Content-Type': ct },
        data: body,
        responseType: 'json',
      })
      const ok = resp.status >= 200 && resp.status < 300
      return { success: ok, status: resp.status, data: resp.data, text: ok ? undefined : JSON.stringify(resp.data) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async getAuthStatus(provider = 'anthropic'): Promise<AuthStatus> {
    return getAuthStatusNative(provider)
  }

  async setAuthKey(key: string, provider = 'anthropic', type: 'api_key' | 'oauth' = 'api_key'): Promise<void> {
    const { setAuthKey: setAuthKeyNative } = await import('./agent/auth-store')
    await setAuthKeyNative(key, provider, 'main', type)
  }

  // ── Scheduler / heartbeat / cron ─────────────────────────────────────

  async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
    if (!this._cronDb) return
    await this._cronDb.setSchedulerConfig(config as Record<string, unknown>)
  }

  async getSchedulerConfig(): Promise<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }> {
    if (this._cronDb) {
      const scheduler = await this._cronDb.getSchedulerConfig()
      const heartbeat = await this._cronDb.getHeartbeatConfig()
      return { scheduler, heartbeat }
    }
    return {
      scheduler: { enabled: false, schedulingMode: 'balanced' } as SchedulerConfig,
      heartbeat: { everyMs: 1_800_000 } as HeartbeatConfig,
    }
  }

  async setHeartbeat(config: Partial<HeartbeatConfig>): Promise<void> {
    if (this._cronDb) {
      await this._cronDb.setHeartbeatConfig(config as Record<string, unknown>)
    }
  }

  async triggerHeartbeatWake(source = 'manual'): Promise<void> {
    if (this._heartbeatManager) {
      await this._heartbeatManager.handleWake(source, { force: source === 'manual' })
    }
  }

  async addCronJob(job: CronJobInput): Promise<CronJobRecord> {
    if (!this._cronDb) throw new Error('CronDb not initialized')
    return this._cronDb.addCronJob(job) as Promise<CronJobRecord>
  }

  async updateCronJob(id: string, patch: Partial<CronJobInput>): Promise<void> {
    if (!this._cronDb) throw new Error('Cron not initialized')
    await this._cronDb.updateCronJob(id, patch as Record<string, unknown>)
  }

  async removeCronJob(id: string): Promise<void> {
    if (!this._cronDb) throw new Error('CronDb not initialized')
    await this._cronDb.removeCronJob(id)
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    if (!this._cronDb) return []
    return this._cronDb.listCronJobs()
  }

  async runCronJob(id: string): Promise<void> {
    if (this._heartbeatManager) {
      await this._heartbeatManager.handleWake('manual', { force: true, forceJobId: id })
    }
  }

  async getCronRunHistory(_jobId?: string, _limit = 50): Promise<CronRunRecord[]> {
    // TODO: CronDbAccess doesn't have listRuns yet — add when needed
    return []
  }

  async addSkill(skill: CronSkillInput): Promise<CronSkillRecord> {
    if (!this._cronDb) throw new Error('CronDb not initialized')
    return this._cronDb.addCronSkill(skill)
  }

  async updateSkill(id: string, patch: Partial<CronSkillInput>): Promise<void> {
    if (!this._cronDb) throw new Error('CronDb not initialized')
    await this._cronDb.updateCronSkill(id, patch as Record<string, unknown>)
  }

  async removeSkill(id: string): Promise<void> {
    if (!this._cronDb) throw new Error('CronDb not initialized')
    await this._cronDb.removeCronSkill(id)
  }

  async listSkills(): Promise<CronSkillRecord[]> {
    if (!this._cronDb) return []
    return this._cronDb.listCronSkills()
  }

  // ── File operations ────────────────────────────────────────────────────

  async readFile(path: string): Promise<FileReadResult> {
    const result = await readFileNative({ path })
    const details = result.details as any
    return { path, content: details?.content || '', error: details?.error }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFileNative({ path, content })
  }

  // ── Session management ─────────────────────────────────────────────────

  async listSessions(agentId = 'main'): Promise<SessionListResult> {
    if (!this._sessionStore) return { agentId, sessions: [] }
    const sessions = await this._sessionStore.listSessions(agentId)
    return { agentId, sessions }
  }

  async getLatestSession(agentId = 'main'): Promise<SessionInfo | null> {
    if (!this._sessionStore) return null
    return this._sessionStore.getLatestSession(agentId)
  }

  async loadSessionHistory(sessionKey: string, _agentId = 'main'): Promise<SessionHistoryResult> {
    if (!this._sessionStore) return { sessionKey, messages: [] }
    const messages = await this._sessionStore.loadMessages(sessionKey)
    return { sessionKey, messages }
  }

  async resumeSession(
    sessionKey: string,
    agentId = 'main',
    options?: { messages?: import('@mariozechner/pi-agent-core').AgentMessage[] },
  ): Promise<{ success: boolean; error?: string; sessionKey?: string; messageCount?: number }> {
    this._currentSessionKey = sessionKey

    if (!this._agentRunner) {
      return { success: false, error: 'Agent runner not initialized' }
    }

    try {
      const [authResult, systemPrompt] = await Promise.all([getAuthToken('anthropic', agentId), loadSystemPrompt()])

      if (!authResult.apiKey) {
        return { success: false, error: 'No API key configured' }
      }

      const messages = options?.messages ?? []
      await this._agentRunner.resume({
        sessionKey,
        messages,
        systemPrompt,
        apiKey: authResult.apiKey,
        provider: 'anthropic',
        extraTools: this._extraAgentTools,
      })

      return { success: true, sessionKey, messageCount: messages.length }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to resume session' }
    }
  }

  async clearConversation(): Promise<{ success: boolean }> {
    this._currentSessionKey = null
    if (this._agentRunner) {
      this._agentRunner.clear()
    }
    return { success: true }
  }

  async setSessionKey(sessionKey: string): Promise<void> {
    this._currentSessionKey = sessionKey
  }

  async getSessionKey(): Promise<{ sessionKey: string | null }> {
    return { sessionKey: this._currentSessionKey }
  }

  // ── Tool invocation ────────────────────────────────────────────────────

  async invokeTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolInvokeResult> {
    if (!this._toolProxy) {
      return { toolName, error: 'Tool proxy not initialized' } as ToolInvokeResult
    }
    const tools = this._toolProxy.buildTools()
    const tool = tools.find((t) => t.name === toolName)
    if (!tool) {
      return { toolName, error: `Unknown tool: ${toolName}` } as ToolInvokeResult
    }
    const toolCallId = `invoke-${Date.now()}`
    const result = await tool.execute(toolCallId, args)
    return { toolName, result } as ToolInvokeResult
  }

  // ── Events (Capacitor plugin pattern) ──────────────────────────────────

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

  onMessage(type: string, handler: MessageHandler, opts?: { once?: boolean }): () => void {
    return this._onMessage(type, handler, opts)
  }

  dispatchEvent(message: Record<string, unknown>): void {
    this._dispatch(message)
  }
}
