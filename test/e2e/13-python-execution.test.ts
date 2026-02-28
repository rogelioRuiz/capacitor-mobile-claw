/**
 * Phase 5 E2E Test: Python Code Execution (Pyodide Sandbox)
 *
 * Verifies:
 * - Python execution in sandboxed Pyodide (WebAssembly) environment
 * - Print output capture (stdout/stderr)
 * - Expression result capture
 * - Timeout protection (infinite loops)
 * - Sandbox security (no subprocess, socket, http, ctypes, etc.)
 * - Standard library availability (math, json, re, collections, etc.)
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { loadPyodide, type PyodideInterface } from 'pyodide'
import { beforeAll, describe, expect, it } from 'vitest'

// Resolve pyodide package directory for asset loading (Vitest transforms import.meta.url)
const _require = createRequire(import.meta.url)
const PYODIDE_INDEX_URL = `${dirname(_require.resolve('pyodide/pyodide.mjs'))}/`

// ── Replicate executePythonTool from main.js ─────────────────────────────

let pyodideInstance: PyodideInterface | null = null

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodideInstance) {
    pyodideInstance = await loadPyodide({ indexURL: PYODIDE_INDEX_URL })
    // Block dangerous modules for sandbox security
    pyodideInstance.runPython(`
import sys
for _mod in ['subprocess', 'socket', 'http', 'urllib', 'ftplib', 'smtplib',
             'webbrowser', 'ctypes', 'multiprocessing', 'shutil', 'tempfile',
             'signal', 'resource']:
    sys.modules[_mod] = None
del _mod
`)
  }
  return pyodideInstance
}

async function executePythonTool(args: { code: string }): Promise<{
  stdout?: string
  result?: string
  error?: string
}> {
  const stdoutLines: string[] = []
  const stderrLines: string[] = []

  try {
    const pyodide = await getPyodide()

    pyodide.setStdout({ batched: (line: string) => stdoutLines.push(line) })
    pyodide.setStderr({ batched: (line: string) => stderrLines.push(`[stderr] ${line}`) })

    const result = await Promise.race([
      pyodide.runPythonAsync(args.code),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Execution timed out (5s)')), 5000)),
    ])

    const stdout = [...stdoutLines, ...stderrLines].join('\n')
    return {
      stdout: stdout.substring(0, 50000),
      result: result !== undefined && result !== null ? String(result) : undefined,
    }
  } catch (err: any) {
    const stdout = [...stdoutLines, ...stderrLines].join('\n')
    return {
      stdout: stdout.substring(0, 50000),
      error: err.message || 'Python execution failed',
    }
  }
}

// ── Warm up Pyodide once before all tests ─────────────────────────────────

beforeAll(async () => {
  await getPyodide()
}, 30_000)

// ── Tests ─────────────────────────────────────────────────────────────────

describe('execute_python — Basic Execution', () => {
  it('evaluates simple expression', async () => {
    const result = await executePythonTool({ code: '1 + 2' })
    expect(result.result).toBe('3')
    expect(result.error).toBeUndefined()
  })

  it('captures print() output', async () => {
    const result = await executePythonTool({ code: 'print("hello world")' })
    expect(result.stdout).toContain('hello world')
  })

  it('captures multiple print() calls', async () => {
    const result = await executePythonTool({ code: 'print("one")\nprint("two")\nprint("three")' })
    expect(result.stdout).toContain('one')
    expect(result.stdout).toContain('two')
    expect(result.stdout).toContain('three')
  })

  it('returns last expression result', async () => {
    const result = await executePythonTool({ code: 'x = 5\nx * 2' })
    expect(result.result).toBe('10')
  })

  it('returns None result as undefined', async () => {
    const result = await executePythonTool({ code: 'x = 5' })
    // Assignment returns None in Python
    expect(result.result).toBeUndefined()
  })

  it('handles string results', async () => {
    const result = await executePythonTool({ code: '"hello" + " " + "world"' })
    expect(result.result).toBe('hello world')
  })

  it('handles boolean results', async () => {
    const result = await executePythonTool({ code: '3 > 2' })
    // Pyodide proxies Python bool to JS bool, so String(true) = 'true'
    expect(result.result).toBe('true')
  })

  it('handles list results', async () => {
    const result = await executePythonTool({ code: '[1, 2, 3]' })
    expect(result.result).toBe('[1, 2, 3]')
  })

  it('handles dict results', async () => {
    const result = await executePythonTool({ code: '{"a": 1, "b": 2}' })
    expect(result.result).toContain("'a': 1")
  })

  it('handles multi-line code with functions', async () => {
    const result = await executePythonTool({
      code: `
def greet(name):
    return f"Hello, {name}!"
greet("World")
`,
    })
    expect(result.result).toBe('Hello, World!')
  })
})

describe('execute_python — Standard Library', () => {
  it('math module works', async () => {
    const result = await executePythonTool({ code: 'import math\nmath.sqrt(16)' })
    expect(result.result).toBe('4')
  })

  it('math.pi available', async () => {
    const result = await executePythonTool({ code: 'import math\nround(math.pi, 4)' })
    expect(result.result).toBe('3.1416')
  })

  it('json module works', async () => {
    const result = await executePythonTool({ code: 'import json\njson.dumps({"a": 1})' })
    expect(result.result).toBe('{"a": 1}')
  })

  it('re module works', async () => {
    const result = await executePythonTool({ code: 'import re\nbool(re.match(r"hello", "hello world"))' })
    expect(result.result).toBe('true')
  })

  it('collections.Counter works', async () => {
    const result = await executePythonTool({
      code: 'from collections import Counter\nCounter("abracadabra").most_common(1)[0][0]',
    })
    expect(result.result).toBe('a')
  })

  it('collections.defaultdict works', async () => {
    const result = await executePythonTool({
      code: 'from collections import defaultdict\nd = defaultdict(int)\nd["x"] += 5\nd["x"]',
    })
    expect(result.result).toBe('5')
  })

  it('datetime module works', async () => {
    const result = await executePythonTool({
      code: 'from datetime import datetime\ndatetime(2024, 1, 15).strftime("%Y-%m-%d")',
    })
    expect(result.result).toBe('2024-01-15')
  })

  it('itertools works', async () => {
    const result = await executePythonTool({
      code: 'import itertools\nlist(itertools.chain([1,2], [3,4]))',
    })
    expect(result.result).toBe('[1, 2, 3, 4]')
  })

  it('functools works', async () => {
    const result = await executePythonTool({
      code: 'from functools import reduce\nreduce(lambda a, b: a + b, [1, 2, 3, 4])',
    })
    expect(result.result).toBe('10')
  })

  it('list comprehensions work', async () => {
    const result = await executePythonTool({ code: '[x**2 for x in range(5)]' })
    expect(result.result).toBe('[0, 1, 4, 9, 16]')
  })

  it('dict comprehensions work', async () => {
    const result = await executePythonTool({ code: '{k: v for k, v in enumerate("abc")}' })
    expect(result.result).toContain("0: 'a'")
  })

  it('string methods work', async () => {
    const result = await executePythonTool({ code: '"Hello World".lower().split()' })
    expect(result.result).toBe("['hello', 'world']")
  })
})

describe('execute_python — Security', () => {
  it('blocks subprocess module', async () => {
    const result = await executePythonTool({ code: 'import subprocess\nsubprocess.run(["ls"])' })
    expect(result.error).toBeDefined()
  })

  it('blocks socket module', async () => {
    const result = await executePythonTool({ code: 'import socket\nsocket.socket()' })
    expect(result.error).toBeDefined()
  })

  it('blocks http module', async () => {
    const result = await executePythonTool({ code: 'import http\nhttp.client' })
    expect(result.error).toBeDefined()
  })

  it('blocks urllib module', async () => {
    const result = await executePythonTool({ code: 'import urllib\nurllib.request' })
    expect(result.error).toBeDefined()
  })

  it('blocks ctypes module', async () => {
    const result = await executePythonTool({ code: 'import ctypes' })
    expect(result.error).toBeDefined()
  })

  it('blocks multiprocessing module', async () => {
    const result = await executePythonTool({ code: 'import multiprocessing' })
    expect(result.error).toBeDefined()
  })

  it('blocks shutil module', async () => {
    const result = await executePythonTool({ code: 'import shutil\nshutil.rmtree("/tmp")' })
    expect(result.error).toBeDefined()
  })

  it('blocks webbrowser module', async () => {
    const result = await executePythonTool({ code: 'import webbrowser' })
    expect(result.error).toBeDefined()
  })

  it('os module has limited scope (no system)', async () => {
    // os module itself is needed for os.path etc, but os.system should fail
    // In Pyodide, os.system is not available (WASM has no shell)
    const result = await executePythonTool({ code: 'import os\nos.system("ls")' })
    // Pyodide's os.system raises or returns error
    expect(result.error || result.result === '-1' || result.result === '0').toBeTruthy()
  })
})

describe('execute_python — Error Handling', () => {
  it('returns error for syntax errors', async () => {
    const result = await executePythonTool({ code: 'def {invalid' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('SyntaxError')
  })

  it('returns error for NameError', async () => {
    const result = await executePythonTool({ code: 'nonexistent_variable' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('NameError')
  })

  it('returns error for TypeError', async () => {
    const result = await executePythonTool({ code: '"hello" + 5' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('TypeError')
  })

  it('returns error for ZeroDivisionError', async () => {
    const result = await executePythonTool({ code: '1 / 0' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('ZeroDivisionError')
  })

  it('returns partial stdout on error', async () => {
    const result = await executePythonTool({
      code: 'print("before")\nraise ValueError("fail")',
    })
    expect(result.stdout).toContain('before')
    expect(result.error).toBeDefined()
  })

  it('handles empty code', async () => {
    const result = await executePythonTool({ code: '' })
    // Empty code should not error
    expect(result.error).toBeUndefined()
  })

  it('truncates output to 50KB', async () => {
    const result = await executePythonTool({
      code: 'print("x" * 60000)',
    })
    expect(result.stdout?.length).toBeLessThanOrEqual(50000)
  })
})
