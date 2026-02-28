/**
 * Phase 3 E2E Test: Enhanced File Tools
 *
 * Verifies:
 * - grep_files searches file contents by regex
 * - find_files finds files by glob pattern
 * - edit_file applies surgical find-and-replace
 * - globToRegex converts glob patterns to regex
 * - Path traversal blocked on all tools
 * - SKIP_DIRS (.git, .openclaw, node_modules) excluded
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TEST_ROOT = join(process.cwd(), '.test-enhanced-file-tools')
const WORKSPACE = join(TEST_ROOT, 'workspace')

const SKIP_DIRS = new Set(['.git', '.openclaw', 'node_modules'])

// ── Replicate globToRegex from main.js ──────────────────────────────────

function globToRegex(glob: string) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

// ── Replicate grepFilesTool from main.js ────────────────────────────────

function grepFilesTool(args: { pattern: string; path?: string; case_insensitive?: boolean }) {
  const searchPath = resolve(WORKSPACE, args.path || '.')
  if (!searchPath.startsWith(resolve(WORKSPACE))) {
    return { error: 'Access denied: path outside workspace' }
  }

  try {
    const flags = args.case_insensitive ? 'gi' : 'g'
    const regex = new RegExp(args.pattern, flags)
    const matches: any[] = []
    const MAX_MATCHES = 200

    function searchDir(dirPath: string) {
      if (matches.length >= MAX_MATCHES) return
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) return
        if (SKIP_DIRS.has(entry.name)) continue
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          searchDir(fullPath)
        } else if (entry.isFile()) {
          try {
            const content = readFileSync(fullPath, 'utf8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_MATCHES) break
              regex.lastIndex = 0
              if (regex.test(lines[i])) {
                const relPath = fullPath.substring(resolve(WORKSPACE).length + 1)
                matches.push({
                  file: relPath,
                  line: i + 1,
                  content: lines[i].substring(0, 500),
                })
              }
            }
          } catch {
            // skip binary or unreadable files
          }
        }
      }
    }

    try {
      if (statSync(searchPath).isFile()) {
        const content = readFileSync(searchPath, 'utf8')
        const lines = content.split('\n')
        const relPath = searchPath.substring(resolve(WORKSPACE).length + 1)
        const regex2 = new RegExp(args.pattern, flags)
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          regex2.lastIndex = 0
          if (regex2.test(lines[i])) {
            matches.push({ file: relPath, line: i + 1, content: lines[i].substring(0, 500) })
          }
        }
      } else {
        searchDir(searchPath)
      }
    } catch {
      searchDir(searchPath)
    }

    return { matches, total: matches.length }
  } catch (err: any) {
    return { error: `Search failed: ${err.message}` }
  }
}

// ── Replicate findFilesTool from main.js ────────────────────────────────

function findFilesTool(args: { pattern: string; path?: string }) {
  const searchPath = resolve(WORKSPACE, args.path || '.')
  if (!searchPath.startsWith(resolve(WORKSPACE))) {
    return { error: 'Access denied: path outside workspace' }
  }

  try {
    const results: any[] = []
    const pattern = globToRegex(args.pattern)
    const MAX_RESULTS = 200

    function searchDir(dirPath: string) {
      if (results.length >= MAX_RESULTS) return
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return
        if (SKIP_DIRS.has(entry.name)) continue
        const fullPath = join(dirPath, entry.name)
        if (pattern.test(entry.name)) {
          const relPath = fullPath.substring(resolve(WORKSPACE).length + 1)
          results.push({
            path: relPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isFile() ? statSync(fullPath).size : undefined,
          })
        }
        if (entry.isDirectory()) {
          searchDir(fullPath)
        }
      }
    }

    searchDir(searchPath)
    return { files: results, total: results.length }
  } catch (err: any) {
    return { error: `Find failed: ${err.message}` }
  }
}

// ── Replicate editFileTool from main.js ─────────────────────────────────

function editFileTool(args: { path: string; old_text: string; new_text: string }) {
  const filePath = resolve(WORKSPACE, args.path)
  if (!filePath.startsWith(resolve(WORKSPACE))) {
    return { error: 'Access denied: path outside workspace' }
  }

  try {
    const content = readFileSync(filePath, 'utf8')
    const index = content.indexOf(args.old_text)
    if (index === -1) {
      return { error: 'old_text not found in file. Use read_file to verify the exact content.' }
    }

    const newContent = content.substring(0, index) + args.new_text + content.substring(index + args.old_text.length)
    writeFileSync(filePath, newContent)

    return { success: true, path: args.path, replacements: 1 }
  } catch (err: any) {
    return { error: `Failed to edit file: ${err.message}` }
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(join(WORKSPACE, 'src', 'utils'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'tests'), { recursive: true })
  mkdirSync(join(WORKSPACE, '.git', 'objects'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(WORKSPACE, '.openclaw'), { recursive: true })

  writeFileSync(join(WORKSPACE, 'README.md'), '# Hello World\n\nThis is a test project.\n')
  writeFileSync(
    join(WORKSPACE, 'src', 'index.ts'),
    'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n',
  )
  writeFileSync(
    join(WORKSPACE, 'src', 'utils', 'math.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number) {\n  return a * b;\n}\n',
  )
  writeFileSync(
    join(WORKSPACE, 'tests', 'math.test.ts'),
    'import { add } from "../src/utils/math";\n\ntest("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
  )
  writeFileSync(join(WORKSPACE, '.git', 'config'), '[core]\n  bare = false\n')
  writeFileSync(join(WORKSPACE, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n')
  writeFileSync(join(WORKSPACE, '.openclaw', 'state.json'), '{}')
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  it('converts * to .* (match any)', () => {
    const regex = globToRegex('*.ts')
    expect(regex.test('index.ts')).toBe(true)
    expect(regex.test('math.ts')).toBe(true)
    expect(regex.test('index.js')).toBe(false)
  })

  it('converts ? to . (match single char)', () => {
    const regex = globToRegex('?.ts')
    expect(regex.test('a.ts')).toBe(true)
    expect(regex.test('ab.ts')).toBe(false)
  })

  it('escapes regex special chars', () => {
    const regex = globToRegex('file.test.ts')
    expect(regex.test('file.test.ts')).toBe(true)
    expect(regex.test('fileTtestTts')).toBe(false)
  })

  it('handles multiple wildcards', () => {
    const regex = globToRegex('test-*.*')
    expect(regex.test('test-math.ts')).toBe(true)
    expect(regex.test('test-foo.js')).toBe(true)
    expect(regex.test('src-math.ts')).toBe(false)
  })

  it('is case-insensitive', () => {
    const regex = globToRegex('README*')
    expect(regex.test('README.md')).toBe(true)
    expect(regex.test('readme.md')).toBe(true)
  })
})

describe('grep_files', () => {
  it('searches file contents by regex', () => {
    const result = grepFilesTool({ pattern: 'function' })
    expect(result.matches).toBeDefined()
    expect(result.matches?.length).toBeGreaterThan(0)
    expect(result.matches?.some((m: any) => m.file.includes('index.ts'))).toBe(true)
  })

  it('returns line numbers and content', () => {
    const result = grepFilesTool({ pattern: 'greet' })
    const match = result.matches?.find((m: any) => m.file === 'src/index.ts')
    expect(match).toBeDefined()
    expect(match?.line).toBeGreaterThan(0)
    expect(match?.content).toContain('greet')
  })

  it('handles case-insensitive search', () => {
    const caseSensitive = grepFilesTool({ pattern: 'hello' })
    const caseInsensitive = grepFilesTool({ pattern: 'hello', case_insensitive: true })
    // "Hello" appears in the code and README
    expect(caseInsensitive.matches?.length).toBeGreaterThanOrEqual(caseSensitive.matches?.length)
  })

  it('searches recursively through subdirectories', () => {
    const result = grepFilesTool({ pattern: 'multiply' })
    expect(result.matches?.some((m: any) => m.file === 'src/utils/math.ts')).toBe(true)
  })

  it('returns empty matches for non-matching pattern', () => {
    const result = grepFilesTool({ pattern: 'xyznonexistent123' })
    expect(result.matches).toEqual([])
    expect(result.total).toBe(0)
  })

  it('blocks path traversal', () => {
    const result = grepFilesTool({ pattern: 'test', path: '../../etc' })
    expect(result.error).toContain('Access denied')
  })

  it('handles invalid regex gracefully', () => {
    const result = grepFilesTool({ pattern: '[invalid(' })
    expect(result.error).toBeDefined()
  })

  it('skips .git directory', () => {
    const result = grepFilesTool({ pattern: 'bare' })
    // "bare" is in .git/config but should not be found
    expect(result.matches?.every((m: any) => !m.file.startsWith('.git/'))).toBe(true)
  })

  it('skips node_modules directory', () => {
    const result = grepFilesTool({ pattern: 'module.exports' })
    expect(result.matches?.every((m: any) => !m.file.startsWith('node_modules/'))).toBe(true)
  })

  it('truncates long matching lines', () => {
    const longLine = 'x'.repeat(1000)
    writeFileSync(join(WORKSPACE, 'long-line.txt'), `${longLine}\n`)
    const result = grepFilesTool({ pattern: 'x' })
    const match = result.matches?.find((m: any) => m.file === 'long-line.txt')
    expect(match).toBeDefined()
    expect(match?.content.length).toBeLessThanOrEqual(500)
  })

  it('searches a single file when path points to a file', () => {
    const result = grepFilesTool({ pattern: 'add', path: 'src/utils/math.ts' })
    expect(result.matches?.length).toBeGreaterThan(0)
    expect(result.matches?.every((m: any) => m.file === 'src/utils/math.ts')).toBe(true)
  })
})

describe('find_files', () => {
  it('finds files by glob pattern (*.ts)', () => {
    const result = findFilesTool({ pattern: '*.ts' })
    expect(result.files?.length).toBeGreaterThan(0)
    expect(result.files?.some((f: any) => f.path === 'src/index.ts')).toBe(true)
  })

  it('finds files with prefix wildcard (math*)', () => {
    const result = findFilesTool({ pattern: 'math*' })
    expect(result.files?.length).toBeGreaterThan(0)
    expect(result.files?.some((f: any) => f.path.includes('math'))).toBe(true)
  })

  it('searches recursively through subdirectories', () => {
    const result = findFilesTool({ pattern: '*.ts' })
    const paths = result.files?.map((f: any) => f.path)
    expect(paths.some((p: string) => p.includes('/'))).toBe(true)
  })

  it('returns file metadata (path, type, size)', () => {
    const result = findFilesTool({ pattern: 'README.md' })
    expect(result.files?.length).toBe(1)
    const file = result.files?.[0]
    expect(file.path).toBe('README.md')
    expect(file.type).toBe('file')
    expect(file.size).toBeGreaterThan(0)
  })

  it('returns empty for non-matching pattern', () => {
    const result = findFilesTool({ pattern: '*.xyz' })
    expect(result.files).toEqual([])
    expect(result.total).toBe(0)
  })

  it('blocks path traversal', () => {
    const result = findFilesTool({ pattern: '*.ts', path: '../../' })
    expect(result.error).toContain('Access denied')
  })

  it('skips .git directory contents', () => {
    const result = findFilesTool({ pattern: 'config' })
    expect(result.files?.every((f: any) => !f.path.startsWith('.git/'))).toBe(true)
  })

  it('skips node_modules directory contents', () => {
    const result = findFilesTool({ pattern: '*.js' })
    expect(result.files?.every((f: any) => !f.path.startsWith('node_modules/'))).toBe(true)
  })

  it('finds directories too', () => {
    const result = findFilesTool({ pattern: 'utils' })
    expect(result.files?.some((f: any) => f.type === 'directory')).toBe(true)
  })
})

describe('edit_file', () => {
  it('replaces old_text with new_text', () => {
    writeFileSync(join(WORKSPACE, 'edit-test.txt'), 'Hello World')
    const result = editFileTool({ path: 'edit-test.txt', old_text: 'World', new_text: 'Universe' })
    expect(result.success).toBe(true)
    expect(result.replacements).toBe(1)

    const content = readFileSync(join(WORKSPACE, 'edit-test.txt'), 'utf8')
    expect(content).toBe('Hello Universe')
  })

  it('returns error when old_text not found', () => {
    writeFileSync(join(WORKSPACE, 'edit-test2.txt'), 'Hello World')
    const result = editFileTool({ path: 'edit-test2.txt', old_text: 'Goodbye', new_text: 'Hi' })
    expect(result.error).toContain('old_text not found')
  })

  it('handles multi-line old_text', () => {
    writeFileSync(join(WORKSPACE, 'multi-line.txt'), 'line1\nline2\nline3\n')
    const result = editFileTool({ path: 'multi-line.txt', old_text: 'line1\nline2', new_text: 'replaced' })
    expect(result.success).toBe(true)

    const content = readFileSync(join(WORKSPACE, 'multi-line.txt'), 'utf8')
    expect(content).toBe('replaced\nline3\n')
  })

  it('preserves file content outside the edit', () => {
    writeFileSync(join(WORKSPACE, 'preserve.txt'), 'BEFORE target AFTER')
    editFileTool({ path: 'preserve.txt', old_text: 'target', new_text: 'REPLACED' })

    const content = readFileSync(join(WORKSPACE, 'preserve.txt'), 'utf8')
    expect(content).toBe('BEFORE REPLACED AFTER')
  })

  it('only replaces first occurrence', () => {
    writeFileSync(join(WORKSPACE, 'first-only.txt'), 'foo bar foo baz foo')
    editFileTool({ path: 'first-only.txt', old_text: 'foo', new_text: 'XXX' })

    const content = readFileSync(join(WORKSPACE, 'first-only.txt'), 'utf8')
    expect(content).toBe('XXX bar foo baz foo')
  })

  it('blocks path traversal', () => {
    const result = editFileTool({ path: '../../evil.txt', old_text: 'a', new_text: 'b' })
    expect(result.error).toContain('Access denied')
  })

  it('returns error for non-existent file', () => {
    const result = editFileTool({ path: 'nonexistent.txt', old_text: 'a', new_text: 'b' })
    expect(result.error).toContain('Failed to edit file')
  })
})
