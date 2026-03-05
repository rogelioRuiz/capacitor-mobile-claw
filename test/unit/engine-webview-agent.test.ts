import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock native tool modules before importing ToolProxy
vi.mock('../../src/agent/file-tools', () => ({
  readFileNative: vi.fn(),
  writeFileNative: vi.fn(),
  listFilesNative: vi.fn(),
  grepFilesNative: vi.fn(),
  findFilesNative: vi.fn(),
  editFileNative: vi.fn(),
  setWorkspaceRoot: vi.fn(),
}))
vi.mock('../../src/agent/git-tools', () => ({
  gitInitNative: vi.fn(),
  gitStatusNative: vi.fn(),
  gitAddNative: vi.fn(),
  gitCommitNative: vi.fn(),
  gitLogNative: vi.fn(),
  gitDiffNative: vi.fn(),
  setWorkspaceDir: vi.fn(),
}))
vi.mock('../../src/agent/wasm-tools', () => ({
  executeJsNative: vi.fn(),
  executePythonNative: vi.fn(),
}))

import { AgentRunner } from '../../src/agent/agent-runner'
import { readFileNative, writeFileNative } from '../../src/agent/file-tools'
import { SessionStore } from '../../src/agent/session-store'
import { ToolProxy } from '../../src/agent/tool-proxy'

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    details: data,
  }
}

/**
 * Engine WebView agent integration tests.
 *
 * These tests verify the wiring between ToolProxy, AgentRunner, and SessionStore
 * as configured in MobileClawEngine._doInit(). We can't test MobileClawEngine
 * directly (it requires Capacitor native platform), so we test the component
 * integration patterns.
 */
describe('Engine WebView Agent Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('ToolProxy + AgentRunner wiring', () => {
    it('should create ToolProxy and AgentRunner independently', () => {
      const dispatched: any[] = []
      const toolProxy = new ToolProxy()

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
      })

      expect(runner).toBeDefined()
      expect(runner.isRunning).toBe(false)
    })

    it('should allow pre-execute hook to be wired between runner and engine dispatch', () => {
      const dispatched: any[] = []

      const toolProxy = new ToolProxy()

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async (toolCallId, toolName, args) => {
          // Simulates engine._handlePreExecute — fires event and waits for resolver
          return new Promise((resolve) => {
            dispatched.push({ type: 'tool.pre_execute', toolCallId, toolName, args })
            resolve({ args, deny: false })
          })
        },
      })

      expect(runner).toBeDefined()
    })
  })

  describe('native tool execution through proxy', () => {
    it('should execute tools natively without worker bridge', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'file data' }))

      const toolProxy = new ToolProxy()
      const tools = toolProxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const result = await readFile.execute('tc-boot-1', { path: 'startup.txt' })

      expect(readFileNative).toHaveBeenCalledWith({ path: 'startup.txt' })
      expect(result.details).toEqual({ content: 'file data' })
    })
  })

  describe('SessionStore alongside AgentRunner', () => {
    it('should both be constructable for the same session', () => {
      const dispatched: any[] = []
      const toolProxy = new ToolProxy()

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

  describe('concurrent tool execution routing', () => {
    it('should route concurrent calls to correct native tools', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'file a content' }))
      vi.mocked(writeFileNative).mockResolvedValue(toolResult({ success: true }))

      const toolProxy = new ToolProxy()
      const tools = toolProxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!
      const writeFile = tools.find((t) => t.name === 'write_file')!

      // Start two concurrent tool calls
      const [r1, r2] = await Promise.all([
        readFile.execute('tc-a', { path: 'a.txt' }),
        writeFile.execute('tc-b', { path: 'b.txt', content: 'hello' }),
      ])

      // Each resolves with its own result
      expect(r1.details).toEqual({ content: 'file a content' })
      expect(r2.details).toEqual({ success: true })
    })
  })

  describe('pre-execute approval flow', () => {
    it('should fire pre-execute event and deny when hook denies', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'should not reach' }))

      const dispatched: any[] = []
      const toolProxy = new ToolProxy()

      const runner = new AgentRunner({
        dispatch: (msg) => dispatched.push(msg),
        toolProxy,
        preExecuteHook: async (_toolCallId, _toolName, args) => {
          // Immediate denial — no async waiting
          return { args, deny: true, denyReason: 'User denied' }
        },
      })

      // Get wrapped tools
      const tools = (runner as any)._wrapTools(toolProxy.buildTools())
      const readFile = tools.find((t: any) => t.name === 'read_file')!

      // Execute — hook denies immediately
      const result = await readFile.execute('tc-deny-2', { path: 'test.txt' })

      expect(result.content[0].text).toContain('User denied')
      expect(result.details).toEqual({ denied: true, reason: 'User denied' })
      // Native function should NOT have been called
      expect(readFileNative).not.toHaveBeenCalled()
    })

    it('should pass through approved args to native tool', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'ok' }))

      const toolProxy = new ToolProxy()

      const runner = new AgentRunner({
        dispatch: () => {},
        toolProxy,
        preExecuteHook: async (_toolCallId, _toolName, args) => {
          // Approve with transformed args
          return { args: { ...args, extra: 'injected' }, deny: false }
        },
      })

      const tools = (runner as any)._wrapTools(toolProxy.buildTools())
      const readFile = tools.find((t: any) => t.name === 'read_file')!

      const result = await readFile.execute('tc-transform', { path: 'test.txt' })

      // Native function called with transformed args
      expect(readFileNative).toHaveBeenCalledWith({ path: 'test.txt', extra: 'injected' })
      expect(result.details).toEqual({ content: 'ok' })
    })
  })
})
