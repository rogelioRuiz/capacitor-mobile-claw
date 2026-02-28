import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolProxy } from '../../src/agent/tool-proxy'

describe('ToolProxy', () => {
  let proxy: ToolProxy
  let sentMessages: Record<string, unknown>[]
  let mockSend: (msg: Record<string, unknown>) => Promise<void>

  beforeEach(() => {
    proxy = new ToolProxy()
    sentMessages = []
    mockSend = async (msg) => {
      sentMessages.push(msg)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('buildTools', () => {
    it('should return 14 tools matching TOOL_SCHEMAS', () => {
      const tools = proxy.buildTools()
      expect(tools).toHaveLength(14)
    })

    it('should have name, label, description, parameters, and execute on each tool', () => {
      const tools = proxy.buildTools()
      for (const tool of tools) {
        expect(tool.name).toBeDefined()
        expect(tool.label).toBeDefined()
        expect(tool.description).toBeDefined()
        expect(tool.parameters).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })
  })

  describe('worker ready — immediate send', () => {
    it('should send tool.execute immediately when worker is ready', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Start execution — don't await yet (need to resolve via handleResult)
      const promise = readFile.execute('tc-1', { path: 'hello.txt' })

      // Verify the message was sent immediately
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'tool.execute',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: { path: 'hello.txt' },
      })

      // Simulate worker response
      proxy.handleResult({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        result: { content: 'file contents' },
      })

      const result = await promise
      expect(result.details).toEqual({ content: 'file contents' })
    })
  })

  describe('optimistic enqueue — worker not ready', () => {
    it('should queue tool calls when worker is not ready', () => {
      proxy.setBridge(mockSend)
      // Don't call setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Execute without awaiting
      readFile.execute('tc-2', { path: 'queued.txt' })

      // Should NOT have sent yet
      expect(sentMessages).toHaveLength(0)
    })

    it('should flush queued calls when worker becomes ready', async () => {
      proxy.setBridge(mockSend)

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Queue two calls
      const p1 = readFile.execute('tc-3', { path: 'a.txt' })
      const p2 = readFile.execute('tc-4', { path: 'b.txt' })

      expect(sentMessages).toHaveLength(0)

      // Worker comes up
      proxy.setWorkerReady()

      // Both should have been flushed
      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[0]).toMatchObject({ toolCallId: 'tc-3', toolName: 'read_file' })
      expect(sentMessages[1]).toMatchObject({ toolCallId: 'tc-4', toolName: 'read_file' })

      // Resolve them
      proxy.handleResult({ toolCallId: 'tc-3', toolName: 'read_file', result: { content: 'a' } })
      proxy.handleResult({ toolCallId: 'tc-4', toolName: 'read_file', result: { content: 'b' } })

      const r1 = await p1
      const r2 = await p2
      expect(r1.details).toEqual({ content: 'a' })
      expect(r2.details).toEqual({ content: 'b' })
    })
  })

  describe('handleResult', () => {
    it('should resolve with error content when worker returns error', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const promise = readFile.execute('tc-err', { path: 'missing.txt' })
      proxy.handleResult({
        toolCallId: 'tc-err',
        toolName: 'read_file',
        error: 'File not found',
      })

      const result = await promise
      expect(result.content[0].text).toContain('Error executing read_file')
      expect(result.content[0].text).toContain('File not found')
      expect(result.details).toEqual({ error: 'File not found' })
    })

    it('should pass through AgentToolResult format when result has content array', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const promise = readFile.execute('tc-raw', { path: 'test.txt' })
      proxy.handleResult({
        toolCallId: 'tc-raw',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: 'raw result' }] },
      })

      const result = await promise
      expect(result.content).toEqual([{ type: 'text', text: 'raw result' }])
    })

    it('should JSON.stringify non-string results', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const listFiles = tools.find((t) => t.name === 'list_files')!

      const promise = listFiles.execute('tc-json', { path: '.' })
      proxy.handleResult({
        toolCallId: 'tc-json',
        toolName: 'list_files',
        result: { entries: ['file1.txt', 'file2.txt'] },
      })

      const result = await promise
      expect(result.content[0].text).toBe(JSON.stringify({ entries: ['file1.txt', 'file2.txt'] }))
    })

    it('should ignore results for unknown toolCallIds', () => {
      // Should not throw
      proxy.handleResult({
        toolCallId: 'unknown-id',
        toolName: 'read_file',
        result: { content: 'whatever' },
      })
    })
  })

  describe('abort signal', () => {
    it('should resolve immediately with abort message when signal is already aborted', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const controller = new AbortController()
      controller.abort()

      const result = await readFile.execute('tc-aborted', { path: 'test.txt' }, controller.signal)
      expect(result.content[0].text).toContain('aborted')
      expect(result.details).toEqual({ aborted: true })
      // Should NOT have sent a message
      expect(sentMessages).toHaveLength(0)
    })

    it('should resolve with abort message when signal fires mid-flight', async () => {
      proxy.setBridge(mockSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const controller = new AbortController()
      const promise = readFile.execute('tc-mid-abort', { path: 'test.txt' }, controller.signal)

      // Message was sent
      expect(sentMessages).toHaveLength(1)

      // Abort before result arrives
      controller.abort()

      const result = await promise
      expect(result.content[0].text).toContain('aborted')
    })
  })

  describe('bridge send failure', () => {
    it('should resolve with error when bridge send throws', async () => {
      const failSend = async () => {
        throw new Error('bridge disconnected')
      }
      proxy.setBridge(failSend)
      proxy.setWorkerReady()

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const result = await readFile.execute('tc-fail', { path: 'test.txt' })
      expect(result.content[0].text).toContain('Failed to send tool call')
      expect(result.content[0].text).toContain('bridge disconnected')
    })
  })
})
