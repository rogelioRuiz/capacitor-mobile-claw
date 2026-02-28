/**
 * AgentRunner — WebView-side agent orchestration.
 *
 * Runs the AI agent loop directly in the WebView using pi-agent-core and pi-ai.
 * No Node.js worker cold start needed — available immediately on app launch.
 *
 * Tools that need Node.js (file I/O, git, VM) are proxied to the worker via
 * ToolProxy. MCP device tools and session persistence are handled directly
 * in the WebView.
 */

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import type { ToolProxy } from './tool-proxy'

export interface AgentRunnerConfig {
  /** Function to dispatch agent events directly to the engine's listener system */
  dispatch: (msg: Record<string, unknown>) => void
  /** Tool proxy for bridging tool calls to the worker */
  toolProxy: ToolProxy
  /** Pre-execute hook — fires before each tool call, returns approved/denied result */
  preExecuteHook?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PreExecuteResult>
}

export interface PreExecuteResult {
  deny?: boolean
  denyReason?: string
  args: Record<string, unknown>
}

export interface AgentRunParams {
  prompt: string
  agentId: string
  sessionKey: string
  model?: string
  provider?: string
  apiKey: string
  systemPrompt: string
  /** Additional tools (MCP device tools) to merge with proxied worker tools */
  extraTools?: AgentTool<any>[]
}

export class AgentRunner {
  private agent: Agent | null = null
  private currentSessionKey: string | null = null
  private dispatch: (msg: Record<string, unknown>) => void
  private toolProxy: ToolProxy
  private preExecuteHook?: AgentRunnerConfig['preExecuteHook']

  constructor(config: AgentRunnerConfig) {
    this.dispatch = config.dispatch
    this.toolProxy = config.toolProxy
    this.preExecuteHook = config.preExecuteHook
  }

  /** Whether the agent is currently streaming / executing tools */
  get isRunning(): boolean {
    return this.agent?.state.isStreaming ?? false
  }

  get sessionKey(): string | null {
    return this.currentSessionKey
  }

  get currentAgent(): Agent | null {
    return this.agent
  }

  // ── Agent lifecycle ──────────────────────────────────────────────────────

  async run(params: AgentRunParams): Promise<void> {
    const provider = params.provider || 'anthropic'
    const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-5' : null
    const modelId = params.model || defaultModel

    if (!modelId) {
      this.dispatch({
        type: 'agent.error',
        error: `No model specified for provider "${provider}". Select a model in Settings.`,
      })
      return
    }

    const model = (getModel as any)(provider, modelId)
    if (!model) {
      this.dispatch({
        type: 'agent.error',
        error: `Model "${modelId}" not found for provider "${provider}".`,
      })
      return
    }

    // Build tools: proxied worker tools + optional MCP/memory tools
    const workerTools = this._wrapWithPreExecuteHook(this.toolProxy.buildTools())
    const extraTools = params.extraTools ? this._wrapWithPreExecuteHook(params.extraTools) : []
    const tools = [...workerTools, ...extraTools]

    this.agent = new Agent({
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools,
        thinkingLevel: 'off',
      },
      convertToLlm: (messages) =>
        messages.filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
      getApiKey: () => params.apiKey,
    })

    this.currentSessionKey = params.sessionKey

    // Subscribe to events — dispatch DIRECTLY to the engine (no bridge hop)
    this.agent.subscribe((event: AgentEvent) => {
      this._dispatchAgentEvent(event)
    })

    // Echo user prompt to UI
    this.dispatch({
      type: 'agent.event',
      eventType: 'user_message',
      data: { text: params.prompt, sessionKey: params.sessionKey },
    })

    // Run the agent loop
    const startTime = Date.now()
    try {
      await this.agent.prompt(params.prompt)
      await this.agent.waitForIdle()

      const usage = this._extractUsage()
      this.dispatch({
        type: 'agent.completed',
        sessionKey: params.sessionKey,
        usage,
        cumulativeUsage: usage,
        durationMs: Date.now() - startTime,
      })
    } catch (err: any) {
      const retryable = this._isTransientError(err)
      this.dispatch({
        type: 'agent.error',
        error: err.message || 'Unknown error during agent execution',
        code: err.status ? String(err.status) : undefined,
        retryable,
      })
      if (!retryable) {
        this.agent = null
        this.currentSessionKey = null
      }
    }
  }

  /** Continue an existing conversation with a new prompt */
  async followUp(prompt: string): Promise<void> {
    if (!this.agent || this.agent.state.messages.length === 0) {
      this.dispatch({ type: 'agent.error', error: 'No active session to follow up on' })
      return
    }

    // Auto-abort in-flight turn
    if (this.agent.state.isStreaming) {
      this.agent.abort()
      await this.agent.waitForIdle()
      this.dispatch({
        type: 'agent.event',
        eventType: 'interrupted',
        data: { reason: 'New message sent while streaming' },
      })
    }

    // Echo user prompt
    this.dispatch({
      type: 'agent.event',
      eventType: 'user_message',
      data: { text: prompt, sessionKey: this.currentSessionKey },
    })

    const startTime = Date.now()
    try {
      await this.agent.prompt(prompt)
      await this.agent.waitForIdle()

      const usage = this._extractUsage()
      this.dispatch({
        type: 'agent.completed',
        sessionKey: this.currentSessionKey,
        usage,
        cumulativeUsage: usage,
        durationMs: Date.now() - startTime,
      })
    } catch (err: any) {
      const retryable = this._isTransientError(err)
      this.dispatch({
        type: 'agent.error',
        error: err.message || 'Follow-up error',
        code: err.status ? String(err.status) : undefined,
        retryable,
      })
      if (!retryable) {
        this.agent = null
        this.currentSessionKey = null
      }
    }
  }

  /** Abort the current agent turn */
  abort(): void {
    this.agent?.abort()
  }

  /** Send a steering message to the agent mid-turn */
  steer(text: string): void {
    if (!this.agent) return
    this.agent.steer({ role: 'user', content: text, timestamp: Date.now() } as AgentMessage)
  }

  /** Clear the current session (keep transcripts) */
  clear(): void {
    this.agent = null
    this.currentSessionKey = null
  }

  /** Resume a session by hydrating with saved messages */
  resume(params: {
    sessionKey: string
    messages: AgentMessage[]
    systemPrompt: string
    apiKey: string
    model?: string
    provider?: string
    extraTools?: AgentTool<any>[]
  }): void {
    const provider = params.provider || 'anthropic'
    const modelId = params.model || 'claude-sonnet-4-5'
    const model = (getModel as any)(provider, modelId)
    if (!model) return

    const workerTools = this._wrapWithPreExecuteHook(this.toolProxy.buildTools())
    const extraTools = params.extraTools ? this._wrapWithPreExecuteHook(params.extraTools) : []
    const tools = [...workerTools, ...extraTools]

    this.agent = new Agent({
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools,
        thinkingLevel: 'off',
      },
      convertToLlm: (messages) =>
        messages.filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
      getApiKey: () => params.apiKey,
    })

    this.agent.replaceMessages(params.messages)
    this.agent.subscribe((event: AgentEvent) => {
      this._dispatchAgentEvent(event)
    })

    this.currentSessionKey = params.sessionKey
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Map pi-agent-core AgentEvent to bridge protocol messages */
  private _dispatchAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_update': {
        const e = (event as any).assistantMessageEvent
        if (e?.type === 'text_delta') {
          this.dispatch({ type: 'agent.event', eventType: 'text_delta', data: { text: e.delta } })
        }
        if (e?.type === 'thinking_delta') {
          this.dispatch({ type: 'agent.event', eventType: 'thinking', data: { text: e.delta } })
        }
        break
      }
      case 'tool_execution_start':
        this.dispatch({
          type: 'agent.event',
          eventType: 'tool_use',
          data: {
            toolName: (event as any).toolName,
            toolCallId: (event as any).toolCallId,
            args: (event as any).args,
          },
        })
        break
      case 'tool_execution_end':
        this.dispatch({
          type: 'agent.event',
          eventType: 'tool_result',
          data: {
            toolName: (event as any).toolName,
            toolCallId: (event as any).toolCallId,
            result: (event as any).result,
          },
        })
        break
    }
  }

  /** Wrap tools with the pre-execute hook (approval gate) */
  private _wrapWithPreExecuteHook(tools: AgentTool<any>[]): AgentTool<any>[] {
    if (!this.preExecuteHook) return tools
    const hook = this.preExecuteHook
    return tools.map((tool) => ({
      ...tool,
      execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) => {
        // Fire pre-execute hook directly in WebView — instant UI, no bridge hop
        const result = await hook(toolCallId, tool.name, params, signal)

        if (result.deny) {
          return {
            content: [
              { type: 'text' as const, text: result.denyReason || `Tool "${tool.name}" execution was denied.` },
            ],
            details: { denied: true, reason: result.denyReason || 'client_denied' },
          }
        }

        // Execute with (possibly transformed) args
        return tool.execute(toolCallId, result.args, signal, onUpdate)
      },
    }))
  }

  /** Extract cumulative token usage from agent messages */
  private _extractUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    let input = 0
    let output = 0
    if (this.agent) {
      for (const msg of this.agent.state.messages) {
        const m = msg as any
        if (m.role === 'assistant' && m.usage) {
          input += m.usage.input || 0
          output += m.usage.output || 0
        }
      }
    }
    return { inputTokens: input, outputTokens: output, totalTokens: input + output }
  }

  /** Check if an error is transient (worth retrying) */
  private _isTransientError(err: any): boolean {
    const status = err.status || err.statusCode
    if (status === 429 || status === 503 || status === 502) return true
    const msg = (err.message || '').toLowerCase()
    if (msg.includes('rate limit') || msg.includes('overloaded') || msg.includes('timeout')) return true
    return false
  }
}
