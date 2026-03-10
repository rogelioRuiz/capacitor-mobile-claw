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
import {
  deleteAuth as deleteAuthNative,
  getAuthStatus as getAuthStatusNative,
  getAuthToken,
  setAuthKey as setAuthKeyNative,
  setAuthRoot,
} from './agent/auth-store'
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
  private _activeSkillId: string | null = null
  private _skillAgent: any = null // Pi Agent instance for active skill (persists across turns)
  private _skillSessionKey: string | null = null
  private _skillEndRequested = false
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

    if (message.type === 'skill.start') {
      console.log(`[Skill] skill.start received skill=${message.skill}`)
      this._handleSkillStart(message).catch((err) => {
        this._dispatch({ type: 'agent.error', error: err.message || 'Skill start failed' })
      })
      return
    }

    if (message.type === 'skill.end') {
      console.log(`[Skill] skill.end received activeSkill=${this._activeSkillId}`)
      if (this._activeSkillId) {
        this._endSkill(this._activeSkillId, this._skillSessionKey || '')
      }
      return
    }

    // Route skill.tool_result to local listeners (waitForResult tools listen for this)
    if (message.type === 'skill.tool_result') {
      console.log(`[Skill] skill.tool_result routed requestId=${(message as any).requestId}`)
      this._dispatch(message as any)
      return
    }

    // No worker to send to — dispatch locally for any listeners
    this._dispatch(message as any)
  }

  /**
   * Handle a skill.start message: create a persistent skill agent with the
   * skill's custom system prompt, tools, and kickoff. The agent stays alive
   * across turns so follow-up messages reuse it (same as old worker's
   * currentAgent pattern).
   */
  private async _handleSkillStart(message: Record<string, unknown>): Promise<void> {
    const skillId = (message.skill as string) || 'unknown'
    const config = message.config as any
    console.log(`[Skill] _handleSkillStart skillId=${skillId}`)
    if (!config?.systemPrompt || !config?.kickoff) {
      console.warn(`[Skill] skill "${skillId}" missing systemPrompt or kickoff — aborting`)
      this._dispatch({ type: 'agent.error', error: `Skill "${skillId}" missing systemPrompt or kickoff in config` })
      return
    }

    // Guard: end any active skill before starting a new one
    if (this._activeSkillId) {
      console.warn(
        `[Skill] concurrent guard: ending active skill="${this._activeSkillId}" before starting "${skillId}"`,
      )
      this._endSkill(this._activeSkillId, this._skillSessionKey || '')
    }

    // Force a new session for the skill
    const sessionKey = `${skillId}/${Date.now()}`
    this._currentSessionKey = sessionKey
    this._skillEndRequested = false
    console.log(`[Skill] sessionKey=${sessionKey}`)

    // ── Generic flag-based tool builder ─────────────────────────────────
    // Skills declare behavior via flags on tool definitions:
    //   milestone: true       → track milestone, dispatch {skillId}.milestone
    //   bridgeEvent: string   → dispatch event to UI
    //   waitForResult: true   → suspend until skill.tool_result arrives
    //   endsSkill: true       → defer _endSkill() to after turn completes
    //   execute: fn           → custom handler provided by skill
    const milestones: string[] = config.milestones || []
    const milestonesReached = new Set<string>()

    const toToolResult = (result: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      details: result,
    })

    // Context passed to custom execute functions
    const ctx = {
      dispatch: (event: any) => this._dispatch(event),
      writeFile: (path: string, content: string) => writeFileNative({ path, content }),
      readFile: (path: string) => readFileNative({ path }),
      skillId,
      sessionKey,
    }

    const skillTools = (config.tools || []).map((toolDef: any) => {
      const base = {
        name: toolDef.name,
        label: toolDef.name.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        description: toolDef.description || '',
        parameters: toolDef.input_schema || toolDef.inputSchema || { type: 'object', properties: {} },
      } as any

      // milestone tools — validate, track in Set, dispatch progress
      if (toolDef.milestone) {
        base.execute = async (_id: string, params: Record<string, unknown>) => {
          const m = params.milestone as string
          if (milestones.includes(m)) {
            milestonesReached.add(m)
            console.log(`[Skill] milestone=${m} valid=true count=${milestonesReached.size}`)
            this._dispatch({ type: `${skillId}.milestone`, milestone: m, completedCount: milestonesReached.size })
          }
          return toToolResult({ success: true, milestone: m, completedCount: milestonesReached.size })
        }
        return base
      }

      // custom execute — skill provides its own handler
      if (typeof toolDef.execute === 'function') {
        base.execute = async (_id: string, params: Record<string, unknown>) => {
          console.log(`[Skill] custom execute tool=${toolDef.name} endsSkill=${!!toolDef.endsSkill}`)
          const result = await toolDef.execute(params, ctx)
          if (toolDef.endsSkill) this._skillEndRequested = true
          return toToolResult(result || {})
        }
        return base
      }

      // bridgeEvent + waitForResult — dispatch event, suspend until UI responds
      if (toolDef.bridgeEvent && toolDef.waitForResult) {
        const eventType = toolDef.bridgeEvent
        base.execute = async (_id: string, params: Record<string, unknown>) => {
          const requestId = `${toolDef.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
          console.log(`[Skill] waitForResult tool=${toolDef.name} requestId=${requestId} event=${eventType}`)
          return new Promise<ReturnType<typeof toToolResult>>((resolve) => {
            this._onMessage(
              'skill.tool_result',
              (msg: any) => {
                if (msg.requestId === requestId) {
                  console.log(`[Skill] waitForResult resolved tool=${toolDef.name} requestId=${requestId}`)
                  if (toolDef.endsSkill) this._skillEndRequested = true
                  resolve(toToolResult(msg.result || {}))
                }
              },
              { once: true },
            )
            this._dispatch({ type: eventType, requestId, ...params })
          })
        }
        return base
      }

      // bridgeEvent (fire-and-forget) — dispatch event, return success
      if (toolDef.bridgeEvent) {
        const eventType = toolDef.bridgeEvent
        base.execute = async (_id: string, params: Record<string, unknown>) => {
          console.log(`[Skill] bridgeEvent tool=${toolDef.name} event=${eventType}`)
          this._dispatch({ type: eventType, ...params })
          if (toolDef.endsSkill) this._skillEndRequested = true
          return toToolResult({ success: true, applied: true })
        }
        return base
      }

      // endsSkill only (no bridgeEvent, no execute) — dispatch generic event + defer end
      if (toolDef.endsSkill) {
        base.execute = async (_id: string, params: Record<string, unknown>) => {
          console.log(`[Skill] endsSkill tool=${toolDef.name}`)
          this._dispatch({ type: `${skillId}.${toolDef.name}`, ...params })
          this._skillEndRequested = true
          return toToolResult(params)
        }
        return base
      }

      // Generic fallback — dispatch event, return params
      base.execute = async (_id: string, params: Record<string, unknown>) => {
        this._dispatch({ type: `${skillId}.${toolDef.name}`, ...params, skillId, toolName: toolDef.name })
        return toToolResult(params)
      }
      return base
    })

    console.log(`[Skill] built ${skillTools.length} skill tools: ${skillTools.map((t: any) => t.name).join(', ')}`)

    // Activate skill mode — _dispatch will tag agent events with this ID.
    // Stays set until _endSkill() is called (NOT cleared on agent.completed,
    // so follow-up turns keep their skill tags).
    this._activeSkillId = skillId
    this._skillSessionKey = sessionKey

    // Notify that the skill session is starting
    this._dispatch({ type: 'skill.session_started', skillId, sessionKey })

    const provider = (message.provider as string) || 'anthropic'
    try {
      const [authResult] = await Promise.all([getAuthToken(provider, 'main')])
      console.log(`[Skill] auth for provider="${provider}" hasKey=${!!authResult.apiKey}`)
      if (!authResult.apiKey) {
        this._endSkill(skillId, sessionKey)
        this._dispatch({
          type: 'agent.error',
          error: `No API key configured for provider "${provider}". Go to Settings to add one.`,
        })
        return
      }

      const [{ getModel }, { Agent }] = await Promise.all([
        import('@mariozechner/pi-ai'),
        import('@mariozechner/pi-agent-core'),
      ])
      const modelId = 'claude-sonnet-4-5'
      const model = (getModel as any)(provider, modelId)

      // Skill tools win on name conflict (same as old worker's setupNames filter).
      // Base/MCP tools get pre-execute hook wrapping; skill tools do NOT.
      const skillNames = new Set(skillTools.map((t: any) => t.name))
      const filteredExtra = (this._extraAgentTools || [])
        .filter((t: any) => !skillNames.has(t.name))
        .map((t: any) => this._wrapToolWithPreExecute(t))
      const tools = [...skillTools, ...filteredExtra]
      console.log(
        `[Skill] agent created model=${modelId}, ${skillTools.length} skill + ${filteredExtra.length} base = ${tools.length} tools`,
      )

      const agent = new (Agent as any)({
        initialState: { systemPrompt: config.systemPrompt, model, tools, thinkingLevel: 'off' },
        convertToLlm: (messages: any[]) =>
          messages.filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
        getApiKey: () => authResult.apiKey,
      })

      // Permanent subscription — tags events with skill context across ALL turns.
      // Guard: ignore events if this agent's session is no longer active (concurrent guard ended it).
      const mySessionKey = sessionKey
      agent.subscribe((event: any) => {
        if (this._skillSessionKey !== mySessionKey) {
          console.warn(`[Skill] stale session guard dropping event type=${event.type}`)
          return
        }
        switch (event.type) {
          case 'message_update': {
            const e = event.assistantMessageEvent
            if (e.type === 'text_delta') {
              this._dispatch({ type: 'agent.event', eventType: 'text_delta', data: { text: e.delta } })
            }
            if (e.type === 'thinking_delta') {
              this._dispatch({ type: 'agent.event', eventType: 'thinking', data: { text: e.delta } })
            }
            break
          }
          case 'tool_execution_start':
            this._dispatch({
              type: 'agent.event',
              eventType: 'tool_use',
              data: { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
            })
            break
          case 'tool_execution_end':
            this._dispatch({
              type: 'agent.event',
              eventType: 'tool_result',
              data: { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
            })
            break
        }
      })

      // Store for follow-up reuse (same as old worker's currentAgent = agent)
      this._skillAgent = agent

      // Run first turn (kickoff) — no user_message echo for internal instruction
      console.log(`[Skill] running kickoff promptLen=${config.kickoff.length}`)
      await this._runSkillTurn(agent, config.kickoff, sessionKey, modelId, false)
    } catch (err: any) {
      console.error(`[Skill] _handleSkillStart error: ${err.message}`)
      this._endSkill(skillId, sessionKey)
      this._dispatch({ type: 'agent.error', error: err.message || 'Skill agent failed' })
    }
  }

  /**
   * Run a single turn on the skill agent (kickoff or follow-up).
   * Mirrors the old worker's agent.prompt() + waitForIdle() pattern.
   */
  private async _runSkillTurn(
    agent: any,
    prompt: string,
    sessionKey: string,
    modelId: string,
    echoUserMessage: boolean,
  ): Promise<void> {
    console.log(`[Skill] _runSkillTurn promptLen=${prompt.length} sessionKey=${sessionKey} echo=${echoUserMessage}`)
    if (echoUserMessage) {
      this._dispatch({
        type: 'agent.event',
        eventType: 'user_message',
        data: { text: prompt, sessionKey },
      })
    }

    const startTime = Date.now()
    try {
      await agent.prompt(prompt)
      await agent.waitForIdle()
      console.log(`[Skill] waitForIdle completed durationMs=${Date.now() - startTime}`)

      // Guard: skill was ended (e.g. by concurrent guard) while we were waiting
      if (this._skillSessionKey !== sessionKey) {
        console.warn(`[Skill] _runSkillTurn stale session guard after waitForIdle`)
        return
      }

      if (agent.state?.error) {
        console.error('[MobileClaw] skill agent error:', agent.state.error)
      }

      console.log(`[Skill] agent.completed dispatched durationMs=${Date.now() - startTime}`)
      this._dispatch({
        type: 'agent.completed',
        sessionKey,
        model: modelId,
        durationMs: Date.now() - startTime,
      })

      // Deferred skill end — if a tool set _skillEndRequested, end now
      // (after agent.completed so all events retain their skill tag)
      if (this._skillEndRequested && this._activeSkillId) {
        console.log(`[Skill] deferred _endSkill triggered skillId=${this._activeSkillId}`)
        this._skillEndRequested = false
        this._endSkill(this._activeSkillId, sessionKey)
      }
    } catch (err: any) {
      // Guard: ignore errors from aborted/ended skill turns
      if (this._skillSessionKey !== sessionKey) {
        console.warn(`[Skill] _runSkillTurn stale session guard in catch — ignoring error: ${err.message}`)
        return
      }
      console.error(`[Skill] _runSkillTurn error: ${err.message}`)
      this._dispatch({
        type: 'agent.error',
        error: err.message || 'Skill turn failed',
        retryable: err.status === 429 || err.status === 529,
      })
    }
  }

  /** Clear skill state and notify UI */
  private _endSkill(skillId: string, sessionKey: string): void {
    console.log(`[Skill] _endSkill skillId=${skillId} sessionKey=${sessionKey} hadAgent=${!!this._skillAgent}`)
    // Abort any in-progress agent turn to prevent stale events
    if (this._skillAgent) {
      try {
        this._skillAgent.abort()
      } catch (_) {
        /* ignore */
      }
    }
    this._activeSkillId = null
    this._skillAgent = null
    this._skillSessionKey = null
    this._skillEndRequested = false
    this._dispatch({ type: 'skill.ended', skillId, sessionKey })
  }

  /**
   * Wrap a single tool with the pre-execute hook (approval gate).
   * Used for base/MCP tools in skill mode — skill-specific tools skip this.
   */
  private _wrapToolWithPreExecute(tool: any): any {
    if (!this._toolMiddleware) return tool
    const middleware = this._toolMiddleware
    return {
      ...tool,
      execute: async (toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) => {
        const execute = (nextArgs?: Record<string, unknown>) =>
          tool.execute(toolCallId, nextArgs ?? args, signal, onUpdate)
        return middleware({ name: tool.name, toolCallId, args }, execute, signal)
      },
    }
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
    // Tag agent events with active skill ID so consumers can filter
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
        // Only log non-text_delta tags to avoid flooding
        if (msg.eventType !== 'text_delta' && msg.eventType !== 'thinking') {
          console.log(`[Skill] tagged ${msg.type} skill=${this._activeSkillId}`)
        }
      }
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

  // ── Agent control ──────────────────────────────────────────────────────

  async sendMessage(
    prompt: string,
    agentId = 'main',
    options?: { model?: string; provider?: string },
  ): Promise<{ sessionKey: string }> {
    // Skill agent path: reuse the persistent skill agent for follow-ups
    // (same as old worker's currentAgent.prompt(msg.prompt) in agent.start handler)
    if (this._skillAgent && this._activeSkillId && this._skillSessionKey) {
      const sessionKey = this._skillSessionKey
      const modelId = (this._skillAgent.state?.model as any)?.id || 'claude-sonnet-4-5'
      console.log(`[Skill] sendMessage follow-up skillId=${this._activeSkillId} promptLen=${prompt.length}`)

      // Auto-abort in-flight turn before sending new message
      if (this._skillAgent.state.isStreaming) {
        console.warn(`[Skill] sendMessage auto-abort: skill agent is streaming`)
        this._skillAgent.abort()
        await this._skillAgent.waitForIdle()
        this._dispatch({
          type: 'agent.event',
          eventType: 'interrupted',
          data: { reason: 'New message sent while streaming' },
        })
      }

      // Fire and forget — events dispatch through the permanent subscription
      this._runSkillTurn(this._skillAgent, prompt, sessionKey, modelId, true).catch((err) => {
        this._dispatch({ type: 'agent.error', error: err.message })
      })
      return { sessionKey }
    }

    // Regular agent path
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

  /**
   * Update the extra agent tools (e.g. after account tools change).
   * Takes effect on the next agent turn — existing in-flight turns keep their tools.
   */
  updateExtraTools(tools: MobileClawInitOptions['tools']): void {
    this._extraAgentTools = this._buildExtraAgentTools(tools)
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
          // If the tool already returns AgentToolResult-shaped content blocks
          // (e.g. image content blocks from analyze_file), pass them through
          // instead of JSON-stringifying into a text block.
          if (
            result?.content &&
            Array.isArray(result.content) &&
            result.content.length > 0 &&
            result.content[0]?.type
          ) {
            return { content: result.content, details: result }
          }
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

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    const action = typeof config.action === 'string' ? config.action : ''
    const provider =
      typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'anthropic'

    if (action === 'setApiKey') {
      const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
      if (!apiKey) {
        throw new Error('Missing apiKey for setApiKey')
      }
      await setAuthKeyNative(apiKey, provider, 'main', 'api_key')
      return
    }

    if (action === 'setOAuth') {
      const accessToken = typeof config.accessToken === 'string' ? config.accessToken.trim() : ''
      if (!accessToken) {
        throw new Error('Missing accessToken for setOAuth')
      }
      await setAuthKeyNative(accessToken, provider, 'main', 'oauth')
      return
    }

    if (action === 'deleteAuth' || action === 'clearAuth') {
      await deleteAuthNative(provider, 'main')
      return
    }
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
    await setAuthKeyNative(key, provider, 'main', type)
  }

  // ── Scheduler / heartbeat / cron ─────────────────────────────────────

  async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
    if (!this._cronDb) return
    await this._cronDb.setSchedulerConfig(config as Record<string, unknown>)

    // Register/unregister MobileCron sentinel job when toggling enabled
    if (this._mobileCron && 'enabled' in config) {
      if (config.enabled) {
        const full = await this.getSchedulerConfig()
        await this._mobileCron.register({
          name: 'sentinel-heartbeat',
          schedule: {
            kind: 'every',
            everyMs: full.heartbeat.everyMs || 1_800_000,
          },
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
    options?: { messages?: import('@mariozechner/pi-agent-core').AgentMessage[]; provider?: string; model?: string },
  ): Promise<{ success: boolean; error?: string; sessionKey?: string; messageCount?: number }> {
    this._currentSessionKey = sessionKey

    if (!this._agentRunner) {
      return { success: false, error: 'Agent runner not initialized' }
    }

    try {
      const provider = options?.provider || 'anthropic'
      const [authResult, systemPrompt] = await Promise.all([getAuthToken(provider, agentId), loadSystemPrompt()])

      if (!authResult.apiKey) {
        return { success: false, error: `No API key configured for provider "${provider}"` }
      }

      const messages = options?.messages ?? []
      await this._agentRunner.resume({
        sessionKey,
        messages,
        model: options?.model,
        systemPrompt,
        apiKey: authResult.apiKey,
        provider,
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
