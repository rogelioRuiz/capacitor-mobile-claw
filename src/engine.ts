/**
 * MobileClawEngine — Thin presentation-only wrapper.
 *
 * ALL agent logic (LLM calls, tool execution, auth, cron/heartbeat, sessions)
 * runs natively in Rust via the NativeAgent Capacitor plugin. This class is
 * purely the WebView-side event bridge and UI coordinator.
 *
 * What lives here:
 *   - Event dispatch (local listeners for UI rendering)
 *   - MCP server manager (device tools need WebView Capacitor APIs)
 *   - MobileCron registration (native wake timer scheduling)
 *   - OAuth code exchange (CapacitorHttp)
 *
 * What does NOT live here:
 *   - Agent loop, LLM streaming, tool execution, auth store, session store,
 *     cron evaluation, heartbeat — all in Rust.
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

/**
 * Get the NativeAgent plugin synchronously.
 * IMPORTANT: Never await a Capacitor registerPlugin proxy — it returns a
 * Proxy with a .then trap that hangs forever. Always access synchronously.
 * We access via Capacitor.Plugins which is already registered by the native
 * plugin's Android/iOS code — no need to import the npm package.
 */
function getNativeAgent(): any {
  const g = globalThis as any
  g.__nativeAgentPlugin ??= (Capacitor as any).Plugins.NativeAgent
  return g.__nativeAgentPlugin
}

const OPENCLAW_ROOT = 'nodejs/data'

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
  // ── Skill state (UI bridge only — agent loop is in Rust) ────────────
  private _activeSkillId: string | null = null
  private _skillEndRequested = false
  private _skillToolNames: string[] = []
  private _pendingSkillResults = new Map<string, (result: any) => void>()

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
  get mcpManager(): McpServerManager | null {
    return this._mcpManager
  }
  /** @deprecated Always true. */
  get useWebViewAgent(): boolean {
    return true
  }
  /** @deprecated Agent runner is in Rust. */
  get agentRunner(): null {
    return null
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
      const plugin = getNativeAgent()
      const openclawRoot = OPENCLAW_ROOT

      // ── Initialize workspace (creates dirs + default files) ──────────
      await plugin.initWorkspace({
        dbPath: `files://${openclawRoot}/mobile-claw.db`,
        workspacePath: `files://${openclawRoot}/workspace`,
        authProfilesPath: `files://${openclawRoot}/agents/main/agent/auth-profiles.json`,
      })
      this._openclawRoot = openclawRoot

      this._loadingPhase = 'initializing native agent'

      // ── Initialize native agent handle ───────────────────────────────
      // Use files:// prefix so Kotlin plugin resolves to context.filesDir
      await plugin.initialize({
        dbPath: `files://${openclawRoot}/mobile-claw.db`,
        workspacePath: `files://${openclawRoot}/workspace`,
        authProfilesPath: `files://${openclawRoot}/agents/main/agent/auth-profiles.json`,
      })

      // ── Bridge native events to local listeners ──────────────────────
      await plugin.addListener('nativeAgentEvent', (event: { eventType: string; payloadJson: string }) => {
        try {
          const payload = JSON.parse(event.payloadJson)
          this._handleNativeEvent(event.eventType, payload)
        } catch {
          this._handleNativeEvent(event.eventType, { raw: event.payloadJson })
        }
      })

      // ── MCP server (device tools — need WebView Capacitor APIs) ──────
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

        // Register MCP tools with native agent so Rust knows about them
        if (this._mcpToolCount > 0) {
          const toolsJson = JSON.stringify(
            this._mcpManager.getToolSchemas().map((tool) => ({ ...tool, webviewOnly: true })),
          )
          await plugin.startMcp({ toolsJson }).catch(() => {})
        }
      } catch (mcpErr) {
        console.warn('[MobileClaw] MCP bridge start failed (non-fatal):', mcpErr)
      }

      // ── MobileCron (native wake timer) ───────────────────────────────
      await this._initMobileCron(options.mobileCron).catch((err) => {
        console.warn('[MobileClaw] MobileCron init failed (non-fatal):', err)
      })

      // ── Ready ────────────────────────────────────────────────────────
      this._ready = true
      this._loading = false
      this._loadingPhase = 'ready'
      this._error = null

      const readyInfo: MobileClawReadyInfo = {
        nodeVersion: '',
        openclawRoot,
        mcpToolCount: this._mcpToolCount,
      }

      this._dispatch({ type: 'worker.ready', ...readyInfo })
      return readyInfo
    } catch (e: any) {
      this._available = false
      this._error = `Initialization failed: ${e.message}`
      this._loading = false
      return { nodeVersion: '', openclawRoot: '', mcpToolCount: 0 }
    }
  }

  // ── Native event → local dispatch bridge ──────────────────────────────

  private _handleNativeEvent(eventType: string, payload: any): void {
    switch (eventType) {
      case 'text_delta':
        this._dispatch({ type: 'agent.event', eventType: 'text_delta', data: { text: payload.text } })
        break
      case 'thinking':
        this._dispatch({ type: 'agent.event', eventType: 'thinking', data: { text: payload.text } })
        break
      case 'tool_use':
        this._dispatch({ type: 'agent.event', eventType: 'tool_use', data: payload })
        break
      case 'tool_result':
        this._dispatch({ type: 'agent.event', eventType: 'tool_result', data: payload })
        break
      case 'mcp_tool_call':
        void this._handleMcpToolCall(payload)
        break
      case 'user_message':
        this._dispatch({ type: 'agent.event', eventType: 'user_message', data: payload })
        break
      case 'agent.completed':
        this._dispatch({ type: 'agent.completed', ...payload })
        break
      case 'agent.error':
        this._dispatch({ type: 'agent.error', ...payload })
        break
      case 'approval_request':
        // Auto-approve skill tools — they run in the WebView, no user confirmation needed
        if (this._activeSkillId && this._skillToolNames.includes(payload.toolName)) {
          getNativeAgent()
            .respondToApproval({ toolCallId: payload.toolCallId, approved: true })
            .catch(() => {})
          return
        }
        this._dispatch({ type: 'tool.pre_execute', ...payload })
        break
      case 'retry':
        this._dispatch({ type: 'agent.event', eventType: 'retry', data: payload })
        break
      case 'heartbeat.started':
        this._dispatch({ type: 'heartbeat.started', ...payload })
        break
      case 'heartbeat.completed':
        this._dispatch({ type: 'heartbeat.completed', ...payload })
        break
      case 'heartbeat.skipped':
        this._dispatch({ type: 'heartbeat.skipped', ...payload })
        break
      case 'cron.job.started':
        this._dispatch({ type: 'cron.job.started', ...payload })
        break
      case 'cron.job.completed':
        this._dispatch({ type: 'cron.job.completed', ...payload })
        break
      case 'cron.job.error':
        this._dispatch({ type: 'cron.job.error', ...payload })
        break
      case 'cron.notification':
        this._dispatch({ type: 'cron.notification', ...payload })
        break
      case 'scheduler.status':
        this._dispatch({ type: 'scheduler.status', ...payload })
        break
      default:
        this._dispatch({ type: eventType, ...payload })
        break
    }
  }

  private async _handleMcpToolCall(payload: any): Promise<void> {
    const plugin = getNativeAgent()
    const toolCallId = typeof payload?.toolCallId === 'string' ? payload.toolCallId : ''
    const toolName = typeof payload?.toolName === 'string' ? payload.toolName : ''
    const args = payload?.args && typeof payload.args === 'object' ? payload.args : {}

    if (!toolCallId || !toolName) return

    try {
      if (!this._mcpManager) {
        throw new Error('MCP manager is not initialized')
      }
      const result = await this._mcpManager.executeTool(toolName, args)
      await plugin.respondToMcpTool({
        toolCallId,
        resultJson: JSON.stringify(result ?? null),
        isError: false,
      })
    } catch (error: any) {
      await plugin
        .respondToMcpTool({
          toolCallId,
          resultJson: JSON.stringify({ error: error?.message || String(error) }),
          isError: true,
        })
        .catch(() => {})
    }
  }

  // ── MobileCron initialization ─────────────────────────────────────────

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
    if (!MobileCron || typeof MobileCron.register !== 'function') return
    this._mobileCron = MobileCron

    const configResult = await this.getSchedulerConfig()
    if (configResult.scheduler.enabled) {
      await MobileCron.register({
        name: 'sentinel-heartbeat',
        schedule: {
          kind: 'every',
          everyMs: configResult.heartbeat.everyMs || 1_800_000,
        },
        activeHours: configResult.heartbeat.activeHours,
        priority: 'normal',
        requiresNetwork: true,
      })
      await MobileCron.setMode({
        mode: configResult.scheduler.schedulingMode,
      })
    }

    // Route MobileCron wake events to native agent
    MobileCron.addListener('jobDue', (event: any) => {
      this.triggerHeartbeatWake(event?.source || 'mobilecron').catch(() => {})
    })
    MobileCron.addListener('nativeWake', (event: any) => {
      this.triggerHeartbeatWake(event?.source || 'workmanager').catch(() => {})
    })
    MobileCron.addListener('overdueJobs', (event: any) => {
      this._dispatch({ type: 'scheduler.overdue', ...event })
      this.triggerHeartbeatWake('foreground').catch(() => {})
    })

    this._onMessage('scheduler.status', (msg) => {
      if (!this._mobileCron) return
      this._mobileCron.setMode({ mode: msg.mode }).catch(() => {})
    })
  }

  async isReady(): Promise<{ ready: boolean }> {
    return { ready: this._ready }
  }

  // ── Agent control ──────────────────────────────────────────────────────

  async sendMessage(
    prompt: string,
    _agentId = 'main',
    options?: { model?: string; provider?: string },
  ): Promise<{ sessionKey: string }> {
    const plugin = getNativeAgent()

    // Skill follow-up: reuse skill session via native followUp.
    // This preserves the skill's system prompt, allowed tools, and prior messages
    // across turns — matching the old JS agent's persistent _skillAgent pattern.
    // The Rust agent loop emits user_message automatically (skip_user_echo=false).
    if (this._activeSkillId && this._currentSessionKey) {
      const sessionKey = this._currentSessionKey
      await plugin.followUp({ prompt })
      return { sessionKey }
    }

    if (!this._currentSessionKey) {
      this._currentSessionKey = `session-${Date.now()}`
    }
    const sessionKey = this._currentSessionKey

    await plugin.sendMessage({
      prompt,
      sessionKey,
      model: options?.model,
      provider: options?.provider || 'anthropic',
      systemPrompt: '',
      maxTurns: 25,
    })

    return { sessionKey }
  }

  async stopTurn(): Promise<void> {
    await getNativeAgent().abort()
  }

  async steerAgent(text: string): Promise<void> {
    await getNativeAgent().steer({ text })
  }

  /**
   * Respond to a tool approval request (from native agent).
   */
  async respondToPreExecute(
    toolCallId: string,
    _args: Record<string, unknown>,
    deny?: boolean,
    denyReason?: string,
  ): Promise<void> {
    await getNativeAgent().respondToApproval({
      toolCallId,
      approved: !deny,
      reason: denyReason,
    })
  }

  /** Respond to a cron approval request. */
  respondToCronApproval(requestId: string, approved: boolean): void {
    getNativeAgent()
      .respondToCronApproval({ requestId, approved })
      .catch(() => {})
  }

  // ── Skill lifecycle ──────────────────────────────────────────────────

  /**
   * Start a skill session. Converts skill tool definitions into MCP tools,
   * registers them with native agent, ensures skill exists in DB, then
   * launches via native startSkill.
   */
  async startSkill(
    skillId: string,
    config: Record<string, unknown>,
    provider?: string,
  ): Promise<{ sessionKey: string }> {
    const plugin = getNativeAgent()

    // Build MCP tools from skill tool definitions and register them
    const skillTools = config.tools as any[] | undefined
    if (Array.isArray(skillTools) && skillTools.length > 0 && this._mcpManager) {
      const mcpTools = this._buildSkillMcpTools(skillId, skillTools, config)
      this._skillToolNames = mcpTools.map((t) => t.name)
      this._mcpManager.addTools(mcpTools)

      // Re-register all MCP tools with native agent
      const toolsJson = JSON.stringify(
        this._mcpManager.getToolSchemas().map((tool) => ({ ...tool, webviewOnly: true })),
      )
      await plugin.startMcp({ toolsJson }).catch(() => {})
      this._mcpToolCount = this._mcpManager.toolCount
    }

    // Ensure skill exists in native DB (Rust start_skill does db::load_skill)
    const skillInput = {
      name: skillId,
      systemPrompt: (config.systemPrompt as string) || '',
      model: (config.model as string) || undefined,
      maxTurns: (config.maxTurns as number) || 25,
    }
    try {
      await plugin.addSkill({ inputJson: JSON.stringify(skillInput) })
    } catch {
      // Skill may already exist — try to update it
      try {
        const existing = JSON.parse((await plugin.listSkills()).skillsJson)
        const found = existing.find((s: any) => s.name === skillId)
        if (found) {
          await plugin.updateSkill({
            id: found.id,
            patchJson: JSON.stringify({
              systemPrompt: skillInput.systemPrompt,
              model: skillInput.model,
              maxTurns: skillInput.maxTurns,
            }),
          })
        }
      } catch {
        /* non-fatal */
      }
    }

    // Build launch config for native startSkill
    // allowedToolsJson restricts the agent to ONLY skill tools — no builtin tools
    const launch = {
      prompt: (config.kickoff as string) || `Run skill ${skillId}`,
      systemPrompt: (config.systemPrompt as string) || '',
      model: config.model,
      maxTurns: (config.maxTurns as number) || 25,
      allowedToolsJson: JSON.stringify(this._skillToolNames),
    }

    // Find the skill ID in DB (native needs the DB ID, not our name)
    let dbSkillId = skillId
    try {
      const existing = JSON.parse((await plugin.listSkills()).skillsJson)
      const found = existing.find((s: any) => s.name === skillId)
      if (found) dbSkillId = found.id
    } catch {
      /* use name as fallback */
    }

    const result = await plugin.startSkill({
      skillId: dbSkillId,
      configJson: JSON.stringify(launch),
      provider: provider || 'anthropic',
    })

    const sessionKey = result.sessionKey || `skill-${skillId}-${Date.now()}`
    this._activeSkillId = skillId
    this._skillEndRequested = false
    this._currentSessionKey = sessionKey

    // Dispatch session_started so consumer listeners pick it up
    this._dispatch({
      type: 'skill.session_started',
      skillId,
      sessionKey,
    })

    return { sessionKey }
  }

  /**
   * End a skill session. Cleans up skill MCP tools and dispatches skill.ended.
   */
  async endSkill(skillId?: string): Promise<void> {
    const id = skillId || this._activeSkillId
    if (!id) return

    // Find DB ID for endSkill call
    const plugin = getNativeAgent()
    try {
      let dbSkillId = id
      const existing = JSON.parse((await plugin.listSkills()).skillsJson)
      const found = existing.find((s: any) => s.name === id)
      if (found) dbSkillId = found.id
      await plugin.endSkill({ skillId: dbSkillId })
    } catch {
      /* non-fatal */
    }

    // Remove skill tools from MCP
    if (this._mcpManager && this._skillToolNames.length > 0) {
      this._mcpManager.removeTools(this._skillToolNames)
      // Re-register tools with native agent
      const toolsJson = JSON.stringify(
        this._mcpManager.getToolSchemas().map((tool) => ({ ...tool, webviewOnly: true })),
      )
      await plugin.startMcp({ toolsJson }).catch(() => {})
      this._mcpToolCount = this._mcpManager.toolCount
    }

    const sessionKey = this._currentSessionKey
    this._activeSkillId = null
    this._skillEndRequested = false
    this._skillToolNames = []
    this._pendingSkillResults.clear()
    this._dispatch({ type: 'skill.ended', skillId: id, sessionKey })
  }

  /**
   * Convert skill tool definitions (with milestone, bridgeEvent, waitForResult,
   * endsSkill, execute flags) into MCP-compatible DeviceTool objects.
   */
  private _buildSkillMcpTools(
    skillId: string,
    toolDefs: any[],
    _config: Record<string, unknown>,
  ): Array<{
    name: string
    description: string
    inputSchema: Record<string, any>
    execute: (args: any) => Promise<any>
  }> {
    return toolDefs.map((def) => ({
      name: def.name,
      description: def.description || '',
      inputSchema: def.input_schema || def.inputSchema || { type: 'object', properties: {} },
      execute: async (args: any) => {
        // milestone tool — dispatch milestone event, return success
        if (def.milestone) {
          const milestoneId = args.milestone || def.name
          this._dispatch({
            type: `${skillId}.milestone`,
            skillId,
            milestone: milestoneId,
            completedCount: 1,
          })
          return { success: true, milestone: milestoneId }
        }

        // bridgeEvent tool — dispatch event to WebView listeners
        if (def.bridgeEvent) {
          const requestId = `${def.name}-${Date.now()}`

          if (def.waitForResult) {
            // Suspend until WebView responds with skill.tool_result
            return new Promise<any>((resolve) => {
              this._pendingSkillResults.set(requestId, resolve)
              this._dispatch({
                type: def.bridgeEvent,
                skillId,
                requestId,
                ...args,
              })
            })
          }

          // Fire-and-forget bridge event
          this._dispatch({
            type: def.bridgeEvent,
            skillId,
            ...args,
          })
          return { success: true }
        }

        // endsSkill tool — execute, then request skill end
        if (def.endsSkill) {
          let result: any = { success: true }
          if (typeof def.execute === 'function') {
            const ctx = {
              dispatch: (msg: any) => this._dispatch(msg),
              writeFile: (path: string, content: string) => this.writeFile(path, content),
            }
            result = await def.execute(args, ctx)
          }
          // Defer skill end until after agent.completed
          this._skillEndRequested = true
          return result
        }

        // Custom execute function
        if (typeof def.execute === 'function') {
          const ctx = {
            dispatch: (msg: any) => this._dispatch(msg),
            writeFile: (path: string, content: string) => this.writeFile(path, content),
          }
          return def.execute(args, ctx)
        }

        return { success: true }
      },
    }))
  }

  /**
   * @deprecated Use respondToPreExecute. Kept for backward compat.
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
    // Skill start — bridge to native startSkill
    if (message.type === 'skill.start') {
      const skillIdVal = message.skill as string
      const configVal = (message.config as Record<string, unknown>) || {}
      const providerVal = message.provider as string | undefined
      try {
        await this.startSkill(skillIdVal, configVal, providerVal)
      } catch (err: any) {
        console.error('[MobileClaw] Skill start failed:', err)
        this._dispatch({ type: 'agent.error', error: err.message || 'Skill start failed' })
      }
      return
    }
    // Skill end
    if (message.type === 'skill.end') {
      await this.endSkill(message.skill as string).catch(() => {})
      return
    }
    // Skill tool result — resolve pending waitForResult promise
    if (message.type === 'skill.tool_result') {
      const requestId = (message as any).requestId as string
      const resolver = requestId ? this._pendingSkillResults.get(requestId) : undefined
      if (resolver) {
        this._pendingSkillResults.delete(requestId)
        resolver((message as any).result ?? { success: true })
      }
      return
    }
    // Route other messages locally
    this._dispatch(message as any)
  }

  // ── Configuration ──────────────────────────────────────────────────────

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    const action = typeof config.action === 'string' ? config.action : ''
    const provider =
      typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'anthropic'
    const plugin = getNativeAgent()

    if (action === 'setApiKey') {
      const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
      if (!apiKey) throw new Error('Missing apiKey for setApiKey')
      await plugin.setAuthKey({ key: apiKey, provider, authType: 'api_key' })
      return
    }

    if (action === 'setOAuth') {
      const accessToken = typeof config.accessToken === 'string' ? config.accessToken.trim() : ''
      if (!accessToken) throw new Error('Missing accessToken for setOAuth')
      await plugin.setAuthKey({ key: accessToken, provider, authType: 'oauth' })
      return
    }

    if (action === 'deleteAuth' || action === 'clearAuth') {
      await plugin.deleteAuth({ provider })
      return
    }
  }

  async exchangeOAuthCode(tokenUrl: string, body: Record<string, string>, contentType?: string): Promise<any> {
    return getNativeAgent().exchangeOAuthCode({
      tokenUrl,
      bodyJson: JSON.stringify(body),
      contentType,
    })
  }

  async getAuthStatus(provider = 'anthropic'): Promise<AuthStatus> {
    const result = await getNativeAgent().getAuthStatus({ provider })
    return { hasKey: result.hasKey, masked: result.masked }
  }

  async setAuthKey(key: string, provider = 'anthropic', type: 'api_key' | 'oauth' = 'api_key'): Promise<void> {
    await getNativeAgent().setAuthKey({ key, provider, authType: type })
  }

  async getModels(
    provider = 'anthropic',
  ): Promise<Array<{ id: string; name: string; description: string; default?: boolean }>> {
    const result = await getNativeAgent().getModels({ provider })
    return JSON.parse(result.modelsJson)
  }

  // ── Scheduler / heartbeat / cron ─────────────────────────────────────

  async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
    const plugin = getNativeAgent()
    await plugin.setSchedulerConfig({ configJson: JSON.stringify(config) })

    // Register/unregister MobileCron sentinel job
    if (this._mobileCron && 'enabled' in config) {
      if (config.enabled) {
        const full = await this.getSchedulerConfig()
        await this._mobileCron.register({
          name: 'sentinel-heartbeat',
          schedule: { kind: 'every', everyMs: full.heartbeat.everyMs || 1_800_000 },
          activeHours: full.heartbeat.activeHours,
          priority: 'normal',
          requiresNetwork: true,
        })
        await this._mobileCron.setMode({
          mode: config.schedulingMode || full.scheduler.schedulingMode,
        })
      } else {
        try {
          const jobs = await this._mobileCron.list()
          const sentinel = (jobs?.jobs || []).find((j: any) => j.name === 'sentinel-heartbeat')
          if (sentinel) await this._mobileCron.unregister({ id: sentinel.id })
        } catch {}
      }
    }
  }

  async getSchedulerConfig(): Promise<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }> {
    const plugin = getNativeAgent()
    const schedulerResult = await plugin.getSchedulerConfig()
    const scheduler = JSON.parse(schedulerResult.schedulerJson)
    const heartbeat = JSON.parse(schedulerResult.heartbeatJson)
    return { scheduler, heartbeat }
  }

  async setHeartbeat(config: Partial<HeartbeatConfig>): Promise<void> {
    await getNativeAgent().setHeartbeatConfig({ configJson: JSON.stringify(config) })
  }

  async triggerHeartbeatWake(source = 'manual'): Promise<void> {
    await getNativeAgent().handleWake({ source })
  }

  async addCronJob(job: CronJobInput): Promise<CronJobRecord> {
    const result = await getNativeAgent().addCronJob({ inputJson: JSON.stringify(job) })
    return JSON.parse(result.recordJson)
  }

  async updateCronJob(id: string, patch: Partial<CronJobInput>): Promise<void> {
    await getNativeAgent().updateCronJob({ id, patchJson: JSON.stringify(patch) })
  }

  async removeCronJob(id: string): Promise<void> {
    await getNativeAgent().removeCronJob({ id })
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    const result = await getNativeAgent().listCronJobs()
    return JSON.parse(result.jobsJson)
  }

  async runCronJob(id: string): Promise<void> {
    await getNativeAgent().runCronJob({ jobId: id })
  }

  async listCronRuns(opts?: { jobId?: string; limit?: number }): Promise<CronRunRecord[]> {
    const result = await getNativeAgent().listCronRuns({ jobId: opts?.jobId, limit: opts?.limit || 100 })
    return JSON.parse(result.runsJson)
  }

  async getCronRunHistory(jobId?: string, limit = 50): Promise<CronRunRecord[]> {
    return this.listCronRuns({ jobId, limit })
  }

  async addSkill(skill: CronSkillInput): Promise<CronSkillRecord> {
    const result = await getNativeAgent().addSkill({ inputJson: JSON.stringify(skill) })
    return JSON.parse(result.recordJson)
  }

  async updateSkill(id: string, patch: Partial<CronSkillInput>): Promise<void> {
    await getNativeAgent().updateSkill({ id, patchJson: JSON.stringify(patch) })
  }

  async removeSkill(id: string): Promise<void> {
    await getNativeAgent().removeSkill({ id })
  }

  async listSkills(): Promise<CronSkillRecord[]> {
    const result = await getNativeAgent().listSkills()
    return JSON.parse(result.skillsJson)
  }

  // ── File operations (delegates to native tools) ────────────────────────

  async readFile(path: string): Promise<FileReadResult> {
    const result = await getNativeAgent().invokeTool({
      toolName: 'read_file',
      argsJson: JSON.stringify({ path }),
    })
    const details = JSON.parse(result.resultJson)
    return { path, content: details?.content || '', error: details?.error }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await getNativeAgent().invokeTool({
      toolName: 'write_file',
      argsJson: JSON.stringify({ path, content }),
    })
  }

  // ── Session management ─────────────────────────────────────────────────

  async listSessions(agentId = 'main'): Promise<SessionListResult> {
    const result = await getNativeAgent().listSessions({ agentId })
    const sessions: SessionInfo[] = JSON.parse(result.sessionsJson)
    return { agentId, sessions }
  }

  async getLatestSession(agentId = 'main'): Promise<SessionInfo | null> {
    const { sessions } = await this.listSessions(agentId)
    return sessions[0] || null
  }

  async loadSessionHistory(sessionKey: string, _agentId = 'main'): Promise<SessionHistoryResult> {
    const result = await getNativeAgent().loadSession({ sessionKey, agentId: _agentId })
    const messages = JSON.parse(result.messagesJson)
    return { sessionKey, messages }
  }

  async resumeSession(
    sessionKey: string,
    agentId = 'main',
    options?: { messages?: any[]; provider?: string; model?: string },
  ): Promise<{ success: boolean; error?: string; sessionKey?: string; messageCount?: number }> {
    this._currentSessionKey = sessionKey
    try {
      await getNativeAgent().resumeSession({
        sessionKey,
        agentId,
        messagesJson: options?.messages ? JSON.stringify(options.messages) : undefined,
        provider: options?.provider,
        model: options?.model,
      })
      return { success: true, sessionKey, messageCount: options?.messages?.length || 0 }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to resume session' }
    }
  }

  async clearConversation(): Promise<{ success: boolean }> {
    this._currentSessionKey = null
    // Only clear in-memory session state on the native side.
    // Don't delete the session from the DB — it should remain in the
    // session index so the user can switch back to it later.
    await getNativeAgent()
      .clearSession()
      .catch(() => {})
    return { success: true }
  }

  async setSessionKey(sessionKey: string): Promise<void> {
    this._currentSessionKey = sessionKey
  }

  async getSessionKey(): Promise<{ sessionKey: string | null }> {
    return { sessionKey: this._currentSessionKey }
  }

  // ── Tool invocation (direct, without agent) ────────────────────────────

  async invokeTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolInvokeResult> {
    try {
      const result = await getNativeAgent().invokeTool({
        toolName,
        argsJson: JSON.stringify(args),
      })
      return { toolName, result: JSON.parse(result.resultJson) }
    } catch (err: any) {
      return { toolName, error: err?.message || `Unknown tool: ${toolName}` }
    }
  }

  // ── Extra tools update (for account tools loaded from WebView) ────────

  updateExtraTools(_tools: MobileClawInitOptions['tools']): void {
    // TODO: pass extra tool definitions to native agent via startMcp/restartMcp
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
      if (bridgeType) this.listeners.delete(bridgeType)
    } else {
      this.listeners.clear()
    }
  }

  onMessage(type: string, handler: MessageHandler, opts?: { once?: boolean }): () => void {
    return this._onMessage(type, handler, opts)
  }

  dispatchEvent(message: Record<string, unknown>): void {
    this._dispatch(message)
  }

  // ── Internal messaging ────────────────────────────────────────────────

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
    // Track active skill for event tagging
    if (msg.type === 'skill.session_started' && msg.skillId) {
      this._activeSkillId = msg.skillId
    } else if (msg.type === 'skill.ended') {
      this._activeSkillId = null
    }

    // Tag agent events with active skill ID
    if (this._activeSkillId && !msg.skill) {
      const agentTypes = [
        'agent.event',
        'agent.completed',
        'agent.error',
        'agent.started',
        'tool.pre_execute',
        'tool.pre_execute.result',
        'tool.pre_execute.expired',
      ]
      if (agentTypes.includes(msg.type)) {
        msg.skill = this._activeSkillId
      }
    }

    // Deferred skill end: when endsSkill tool was called, wait for agent.completed
    // before dispatching skill.ended (so the agent finishes its turn cleanly)
    if (msg.type === 'agent.completed' && this._skillEndRequested && this._activeSkillId) {
      this._skillEndRequested = false
      const skillId = this._activeSkillId
      const sessionKey = this._currentSessionKey
      // Clean up skill tools from MCP before clearing names
      if (this._mcpManager && this._skillToolNames.length > 0) {
        this._mcpManager.removeTools(this._skillToolNames)
      }
      this._activeSkillId = null
      this._skillToolNames = []
      this._pendingSkillResults.clear()
      // Dispatch agent.completed first, then skill.ended
      queueMicrotask(() => {
        this._dispatch({ type: 'skill.ended', skillId, sessionKey })
      })
    }

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
}
