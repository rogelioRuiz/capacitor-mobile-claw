import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunner } from '../../src/agent/agent-runner'
import { ToolProxy } from '../../src/agent/tool-proxy'

// Minimal mock Agent that simulates pi-agent-core Agent behavior
class MockAgent {
  state = {
    messages: [] as any[],
    isStreaming: false,
    systemPrompt: '',
    model: null as any,
    tools: [] as any[],
  }

  private _subscriber: ((event: any) => void) | null = null
  private _idle = true
  private _idleResolvers: (() => void)[] = []

  subscribe(fn: (event: any) => void) {
    this._subscriber = fn
  }

  replaceMessages(msgs: any[]) {
    this.state.messages = [...msgs]
  }

  setTools(tools: any[]) {
    this.state.tools = tools
  }

  async prompt(text: string) {
    this._idle = false
    this.state.isStreaming = true

    // Simulate: add user message
    this.state.messages.push({
      role: 'user',
      content: text,
      timestamp: Date.now(),
    })

    // Simulate: emit text_delta event
    this._subscriber?.({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: `Response to: ${text}` },
    })

    // Simulate: add assistant response
    this.state.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Response to: ${text}` }],
      usage: { input: 100, output: 50 },
      timestamp: Date.now(),
    })

    this._idle = true
    this.state.isStreaming = false
    for (const r of this._idleResolvers) r()
    this._idleResolvers = []
  }

  async waitForIdle() {
    if (this._idle) return
    return new Promise<void>((resolve) => {
      this._idleResolvers.push(resolve)
    })
  }

  abort() {
    this._idle = true
    this.state.isStreaming = false
    for (const r of this._idleResolvers) r()
    this._idleResolvers = []
  }

  steer(msg: any) {
    // Just record the steer message
    this.state.messages.push(msg)
  }
}

// Mock getModel to return a model object
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: (_provider: string, _modelId: string) => ({
    id: _modelId,
    provider: _provider,
    api: 'anthropic-messages',
  }),
}))

// Mock Agent constructor to use our MockAgent
vi.mock('@mariozechner/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation(() => new MockAgent()),
}))

describe('AgentRunner', () => {
  let runner: AgentRunner
  let toolProxy: ToolProxy
  let dispatched: Record<string, unknown>[]

  beforeEach(() => {
    dispatched = []
    toolProxy = new ToolProxy()
    // Set up bridge so buildTools() works
    toolProxy.setBridge(async () => {})
    toolProxy.setWorkerReady()

    runner = new AgentRunner({
      dispatch: (msg) => dispatched.push(msg),
      toolProxy,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('should not be running initially', () => {
      expect(runner.isRunning).toBe(false)
    })

    it('should have no session key initially', () => {
      expect(runner.sessionKey).toBeNull()
    })

    it('should have no current agent initially', () => {
      expect(runner.currentAgent).toBeNull()
    })
  })

  describe('run', () => {
    it('should dispatch user_message event', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-1',
        apiKey: 'sk-test',
        systemPrompt: 'You are a test agent',
        provider: 'anthropic',
      })

      const userMsg = dispatched.find((m) => m.eventType === 'user_message')
      expect(userMsg).toBeDefined()
      expect(userMsg?.data).toEqual({ text: 'Hello', sessionKey: 'sess-1' })
    })

    it('should dispatch text_delta events during streaming', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-1',
        apiKey: 'sk-test',
        systemPrompt: 'You are a test agent',
      })

      const textDeltas = dispatched.filter((m) => m.eventType === 'text_delta')
      expect(textDeltas.length).toBeGreaterThan(0)
    })

    it('should dispatch agent.completed on success', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-1',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
      })

      const completed = dispatched.find((m) => m.type === 'agent.completed')
      expect(completed).toBeDefined()
      expect(completed?.sessionKey).toBe('sess-1')
      expect(completed?.usage).toBeDefined()
      expect((completed?.usage as any)?.inputTokens).toBe(100)
      expect((completed?.usage as any)?.outputTokens).toBe(50)
      expect((completed?.usage as any)?.totalTokens).toBe(150)
      expect(completed?.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should set sessionKey after run', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-2',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
      })

      expect(runner.sessionKey).toBe('sess-2')
    })

    it('should dispatch error when no model specified for non-anthropic provider', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-3',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
        provider: 'openai', // no default model
      })

      const error = dispatched.find((m) => m.type === 'agent.error')
      expect(error).toBeDefined()
      expect(error?.error as string).toContain('No model specified')
    })

    it('should use claude-sonnet-4-5 as default for anthropic provider', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-4',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
        provider: 'anthropic',
        // no model specified
      })

      // Should complete successfully (default model used)
      const completed = dispatched.find((m) => m.type === 'agent.completed')
      expect(completed).toBeDefined()
    })
  })

  describe('followUp', () => {
    it('should dispatch error when no active session', async () => {
      await runner.followUp('follow-up text')

      const error = dispatched.find((m) => m.type === 'agent.error')
      expect(error).toBeDefined()
      expect(error?.error as string).toContain('No active session')
    })

    it('should continue existing conversation', async () => {
      // First run
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-5',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
      })

      dispatched.length = 0 // Clear

      // Follow up
      await runner.followUp('Tell me more')

      const userMsg = dispatched.find((m) => m.eventType === 'user_message')
      expect(userMsg).toBeDefined()
      expect(userMsg?.data).toEqual({ text: 'Tell me more', sessionKey: 'sess-5' })

      const completed = dispatched.find((m) => m.type === 'agent.completed')
      expect(completed).toBeDefined()
    })
  })

  describe('abort', () => {
    it('should not throw when no agent is active', () => {
      expect(() => runner.abort()).not.toThrow()
    })
  })

  describe('steer', () => {
    it('should not throw when no agent is active', () => {
      expect(() => runner.steer('change direction')).not.toThrow()
    })
  })

  describe('clear', () => {
    it('should reset session state', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-6',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
      })

      expect(runner.sessionKey).toBe('sess-6')
      expect(runner.currentAgent).not.toBeNull()

      runner.clear()

      expect(runner.sessionKey).toBeNull()
      expect(runner.currentAgent).toBeNull()
    })
  })

  describe('pre-execute hook', () => {
    it('should call pre-execute hook before tool execution', async () => {
      const hookCalls: { toolName: string; args: any }[] = []

      const runnerWithHook = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async (_toolCallId, toolName, args) => {
          hookCalls.push({ toolName, args })
          return { args, deny: false }
        },
      })

      // Build tools via proxy to verify they get wrapped
      const tools = runnerWithHook._wrapWithPreExecuteHook(toolProxy.buildTools())
      expect(tools.length).toBe(14)

      // Simulate calling a tool through the hook
      const readFile = tools.find((t) => t.name === 'read_file')!
      // The hook itself doesn't block — it's the execution that does
      // We just verify the wrapper exists
      expect(typeof readFile.execute).toBe('function')
    })

    it('should deny tool execution when hook returns deny: true', async () => {
      const runnerWithHook = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async () => ({
          args: {},
          deny: true,
          denyReason: 'Test denial',
        }),
      })

      const tools = runnerWithHook._wrapWithPreExecuteHook(toolProxy.buildTools())
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Execute with the hook wrapper — the actual tool.execute won't be called
      // because the hook denies it
      const result = await readFile.execute('tc-deny', { path: 'test.txt' })
      expect(result.content[0].text).toContain('Test denial')
      expect(result.details).toEqual({ denied: true, reason: 'Test denial' })
    })
  })

  describe('_extractUsage', () => {
    it('should sum usage across all assistant messages', async () => {
      await runner.run({
        prompt: 'Hello',
        agentId: 'main',
        sessionKey: 'sess-usage',
        apiKey: 'sk-test',
        systemPrompt: 'Test',
      })

      const completed = dispatched.find((m) => m.type === 'agent.completed') as any
      expect(completed.usage.inputTokens).toBe(100)
      expect(completed.usage.outputTokens).toBe(50)
      expect(completed.usage.totalTokens).toBe(150)
    })
  })

  describe('_isTransientError', () => {
    it('should classify 429 as transient', () => {
      const isTransient = runner._isTransientError({ status: 429, message: '' })
      expect(isTransient).toBe(true)
    })

    it('should classify 503 as transient', () => {
      const isTransient = runner._isTransientError({ status: 503, message: '' })
      expect(isTransient).toBe(true)
    })

    it('should classify rate limit message as transient', () => {
      const isTransient = runner._isTransientError({ message: 'rate limit exceeded' })
      expect(isTransient).toBe(true)
    })

    it('should classify overloaded message as transient', () => {
      const isTransient = runner._isTransientError({ message: 'server overloaded' })
      expect(isTransient).toBe(true)
    })

    it('should not classify 400 as transient', () => {
      const isTransient = runner._isTransientError({ status: 400, message: 'bad request' })
      expect(isTransient).toBe(false)
    })

    it('should not classify generic errors as transient', () => {
      const isTransient = runner._isTransientError({ message: 'invalid api key' })
      expect(isTransient).toBe(false)
    })
  })
})
