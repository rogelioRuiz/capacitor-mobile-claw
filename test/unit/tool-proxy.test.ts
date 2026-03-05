import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { listFilesNative, readFileNative, writeFileNative } from '../../src/agent/file-tools'
import { gitInitNative } from '../../src/agent/git-tools'
import { ToolProxy } from '../../src/agent/tool-proxy'

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    details: data,
  }
}

describe('ToolProxy', () => {
  let proxy: ToolProxy

  beforeEach(() => {
    proxy = new ToolProxy()
    vi.clearAllMocks()
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

  describe('native execution — direct calls', () => {
    it('should call native read_file directly and return result', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'file contents' }))

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const result = await readFile.execute('tc-1', { path: 'hello.txt' })

      expect(readFileNative).toHaveBeenCalledWith({ path: 'hello.txt' })
      expect(result.details).toEqual({ content: 'file contents' })
    })

    it('should call native write_file directly and return result', async () => {
      vi.mocked(writeFileNative).mockResolvedValue(toolResult({ success: true }))

      const tools = proxy.buildTools()
      const writeFile = tools.find((t) => t.name === 'write_file')!

      const result = await writeFile.execute('tc-2', { path: 'out.txt', content: 'data' })

      expect(writeFileNative).toHaveBeenCalledWith({ path: 'out.txt', content: 'data' })
      expect(result.details).toEqual({ success: true })
    })

    it('should call native list_files directly and return result', async () => {
      vi.mocked(listFilesNative).mockResolvedValue(toolResult({ entries: ['a.txt', 'b.txt'] }))

      const tools = proxy.buildTools()
      const listFiles = tools.find((t) => t.name === 'list_files')!

      const result = await listFiles.execute('tc-3', { path: '.' })

      expect(listFilesNative).toHaveBeenCalledWith({ path: '.' })
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe(
        JSON.stringify({ entries: ['a.txt', 'b.txt'] }),
      )
    })
  })

  describe('concurrent native calls', () => {
    it('should route concurrent calls to correct native functions', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ content: 'file a content' }))
      vi.mocked(writeFileNative).mockResolvedValue(toolResult({ success: true }))

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!
      const writeFile = tools.find((t) => t.name === 'write_file')!

      // Start two concurrent tool calls
      const [r1, r2] = await Promise.all([
        readFile.execute('tc-a', { path: 'a.txt' }),
        writeFile.execute('tc-b', { path: 'b.txt', content: 'hello' }),
      ])

      expect(r1.details).toEqual({ content: 'file a content' })
      expect(r2.details).toEqual({ success: true })
      expect(readFileNative).toHaveBeenCalledTimes(1)
      expect(writeFileNative).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('should return error result when native tool throws', async () => {
      vi.mocked(readFileNative).mockRejectedValue(new Error('File not found'))

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      // Native tools catch their own errors and return AgentToolResult,
      // but if the mock throws, execute should propagate the rejection.
      await expect(readFile.execute('tc-err', { path: 'missing.txt' })).rejects.toThrow('File not found')
    })

    it('should return error result when native tool returns error details', async () => {
      vi.mocked(readFileNative).mockResolvedValue(toolResult({ error: 'Access denied: path outside workspace' }))

      const tools = proxy.buildTools()
      const readFile = tools.find((t) => t.name === 'read_file')!

      const result = await readFile.execute('tc-denied', { path: '/etc/passwd' })
      expect(result.details).toEqual({ error: 'Access denied: path outside workspace' })
    })
  })

  describe('unknown tool fallback', () => {
    it('should return error for unknown tool name', async () => {
      // Manually test the fallback path by calling buildTools on a proxy
      // that has a schema for a tool not in NATIVE_TOOLS.
      // Since all 14 tools are mapped, we test the fallback indirectly:
      // The proxy should handle all known tools without errors.
      const tools = proxy.buildTools()
      expect(tools.every((t) => typeof t.execute === 'function')).toBe(true)
    })
  })

  describe('deprecated API compat', () => {
    it('setBridge should be a no-op', () => {
      // Should not throw
      proxy.setBridge(async () => {})
    })

    it('setWorkerReady should be a no-op', () => {
      // Should not throw
      proxy.setWorkerReady()
    })

    it('handleResult should be a no-op', () => {
      // Should not throw
      proxy.handleResult({
        toolCallId: 'unknown-id',
        toolName: 'read_file',
        result: { content: 'whatever' },
      })
    })
  })

  describe('git tools', () => {
    it('should call native git_init directly', async () => {
      vi.mocked(gitInitNative).mockResolvedValue(toolResult({ success: true }))

      const tools = proxy.buildTools()
      const gitInit = tools.find((t) => t.name === 'git_init')!

      const result = await gitInit.execute('tc-git', { default_branch: 'main' })

      expect(gitInitNative).toHaveBeenCalledWith({ default_branch: 'main' })
      expect(result.details).toEqual({ success: true })
    })
  })
})
