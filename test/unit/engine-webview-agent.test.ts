import { describe, expect, it } from 'vitest'
import { AgentRunner } from '../../src/agent/agent-runner'
import { SessionStore } from '../../src/agent/session-store'
import { ToolProxy } from '../../src/agent/tool-proxy'

/**
 * Engine WebView agent integration tests.
 *
 * These tests verify the wiring between ToolProxy, AgentRunner, and SessionStore
 * as configured in MobileClawEngine._doInit(). We can't test MobileClawEngine
 * directly (it requires Capacitor native platform), so we test the component
 * integration patterns.
 */
describe('Engine WebView Agent Integration', () => {
  describe('ToolProxy + AgentRunner wiring', () => {
    it('should create ToolProxy and AgentRunner independently', () => {
      const dispatched: any[] = []
      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async () => {})

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
      })

      expect(runner).toBeDefined()
      expect(runner.isRunning).toBe(false)
    })

    it('should allow pre-execute hook to be wired between runner and engine dispatch', () => {
      const dispatched: any[] = []
      const preExecuteResolvers = new Map<string, (result: any) => void>()

      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async () => {})
      toolProxy.setWorkerReady()

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async (toolCallId, toolName, args) => {
          // Simulates engine._handlePreExecute — fires event and waits for resolver
          return new Promise((resolve) => {
            preExecuteResolvers.set(toolCallId, resolve)
            dispatched.push({ type: 'tool.pre_execute', toolCallId, toolName, args })
          })
        },
      })

      expect(runner).toBeDefined()
    })
  })

  describe('ToolProxy queue behavior with engine lifecycle', () => {
    it('should queue tool calls during worker boot, then flush on ready', async () => {
      const sentMessages: any[] = []
      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async (msg) => sentMessages.push(msg))

      // Worker not ready yet — simulates cold start period
      const tools = toolProxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Execute tool (goes to pending queue)
      const promise = readFile.execute('tc-boot-1', { path: 'startup.txt' })
      expect(sentMessages).toHaveLength(0)

      // Simulate engine receiving worker.ready → calls toolProxy.setWorkerReady()
      toolProxy.setWorkerReady()

      // Queue flushed
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].toolCallId).toBe('tc-boot-1')

      // Worker responds
      toolProxy.handleResult({
        toolCallId: 'tc-boot-1',
        toolName: 'read_file',
        result: { content: 'file data' },
      })

      const result = await promise
      expect(result.details).toEqual({ content: 'file data' })
    })
  })

  describe('SessionStore alongside AgentRunner', () => {
    it('should both be constructable for the same session', () => {
      const dispatched: any[] = []
      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async () => {})

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
      })

      const store = new SessionStore()

      // Both should work independently
      expect(runner).toBeDefined()
      expect(store).toBeDefined()
      expect(typeof store.saveSession).toBe('function')
      expect(typeof runner.run).toBe('function')
    })
  })

  describe('tool.execute.result dispatch pattern', () => {
    it('should route results to correct inflight call via toolCallId', async () => {
      const sentMessages: any[] = []
      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async (msg) => sentMessages.push(msg))
      toolProxy.setWorkerReady()

      const tools = toolProxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!
      const writeFile = tools.find((t) => t.name === 'write_file')!

      // Start two concurrent tool calls
      const p1 = readFile.execute('tc-a', { path: 'a.txt' })
      const p2 = writeFile.execute('tc-b', { path: 'b.txt', content: 'hello' })

      expect(sentMessages).toHaveLength(2)

      // Resolve in reverse order
      toolProxy.handleResult({
        toolCallId: 'tc-b',
        toolName: 'write_file',
        result: { success: true },
      })
      toolProxy.handleResult({
        toolCallId: 'tc-a',
        toolName: 'read_file',
        result: { content: 'file a content' },
      })

      const r1 = await p1
      const r2 = await p2

      // Each resolves with its own result
      expect(r1.details).toEqual({ content: 'file a content' })
      expect(r2.details).toEqual({ success: true })
    })
  })

  describe('pre-execute approval flow', () => {
    it('should fire pre-execute event and deny when hook denies', async () => {
      const dispatched: any[] = []

      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async () => {})
      toolProxy.setWorkerReady()

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async (_toolCallId, _toolName, args) => {
          // Immediate denial — no async waiting
          return { args, deny: true, denyReason: 'User denied' }
        },
      })

      // Get wrapped tools
      const tools = runner._wrapWithPreExecuteHook(toolProxy.buildTools())
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Execute — hook denies immediately
      const result = await readFile.execute('tc-deny-2', { path: 'test.txt' })

      expect(result.content[0].text).toContain('User denied')
      expect(result.details).toEqual({ denied: true, reason: 'User denied' })
    })

    it('should pass through approved args to tool proxy', async () => {
      const sentMessages: any[] = []
      const toolProxy = new ToolProxy()
      toolProxy.setBridge(async (msg) => sentMessages.push(msg))
      toolProxy.setWorkerReady()

      const runner = new AgentRunner({
        dispatch: () => {},
        toolProxy,
        preExecuteHook: async (_toolCallId, _toolName, args) => {
          // Approve with transformed args
          return { args: { ...args, extra: 'injected' }, deny: false }
        },
      })

      const tools = runner._wrapWithPreExecuteHook(toolProxy.buildTools())
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Execute — hook approves, tool proxy sends to worker
      const promise = readFile.execute('tc-transform', { path: 'test.txt' })

      // Give the async chain a tick to send
      await new Promise((r) => setTimeout(r, 10))

      // Verify the proxy sent the message with transformed args
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].args).toEqual({ path: 'test.txt', extra: 'injected' })

      // Resolve the worker call
      toolProxy.handleResult({
        toolCallId: 'tc-transform',
        toolName: 'read_file',
        result: { content: 'ok' },
      })

      const result = await promise
      expect(result.details).toEqual({ content: 'ok' })
    })
  })
})
