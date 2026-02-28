/**
 * Phase 3 E2E Test: Code Execution (VM Sandbox)
 *
 * Verifies:
 * - JavaScript execution in sandboxed VM context
 * - Console output capture (log, warn, error)
 * - Expression result capture
 * - Timeout protection (infinite loops)
 * - Sandbox security (no require, process, fs, etc.)
 * - Safe built-ins available (Math, Date, JSON, etc.)
 */

import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

// ── Replicate executeJsTool from main.js ────────────────────────────────

function executeJsTool(args: { code: string }) {
  const stdoutLines: string[] = []
  const sandbox: any = {
    console: {
      log: (...a: any[]) => stdoutLines.push(a.map(String).join(' ')),
      warn: (...a: any[]) => stdoutLines.push(`[warn] ${a.map(String).join(' ')}`),
      error: (...a: any[]) => stdoutLines.push(`[error] ${a.map(String).join(' ')}`),
    },
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Promise,
    Symbol,
    process: undefined,
    require: undefined,
    global: undefined,
    globalThis: undefined,
    Buffer: undefined,
    setTimeout: undefined,
    setInterval: undefined,
  }
  const context = vm.createContext(sandbox)
  try {
    const result = vm.runInContext(args.code, context, { timeout: 5000, filename: 'sandbox.js' })
    const stdout = stdoutLines.join('\n')
    return {
      stdout: stdout.substring(0, 50000),
      result: result !== undefined ? String(result) : undefined,
    }
  } catch (err: any) {
    return {
      stdout: stdoutLines.join('\n').substring(0, 50000),
      error: err.message || 'Execution failed',
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('execute_js — Basic Execution', () => {
  it('executes simple expression and returns result', () => {
    const result = executeJsTool({ code: '2 + 3' })
    expect(result.result).toBe('5')
    expect(result.error).toBeUndefined()
  })

  it('captures console.log as stdout', () => {
    const result = executeJsTool({ code: 'console.log("hello world")' })
    expect(result.stdout).toBe('hello world')
  })

  it('captures multiple console.log calls', () => {
    const result = executeJsTool({ code: 'console.log("one"); console.log("two"); console.log("three")' })
    expect(result.stdout).toBe('one\ntwo\nthree')
  })

  it('captures console.warn and console.error', () => {
    const result = executeJsTool({ code: 'console.warn("warning"); console.error("problem")' })
    expect(result.stdout).toContain('[warn] warning')
    expect(result.stdout).toContain('[error] problem')
  })

  it('returns both stdout and result', () => {
    const result = executeJsTool({ code: 'console.log("side effect"); 42' })
    expect(result.stdout).toBe('side effect')
    expect(result.result).toBe('42')
  })

  it('returns undefined result for statement-only code', () => {
    const result = executeJsTool({ code: 'const x = 5;' })
    expect(result.result).toBeUndefined()
  })

  it('handles string results', () => {
    const result = executeJsTool({ code: '"hello" + " " + "world"' })
    expect(result.result).toBe('hello world')
  })

  it('handles boolean results', () => {
    const result = executeJsTool({ code: '3 > 2' })
    expect(result.result).toBe('true')
  })

  it('handles array results (stringified)', () => {
    const result = executeJsTool({ code: '[1, 2, 3]' })
    expect(result.result).toBe('1,2,3')
  })

  it('captures console.log with multiple arguments', () => {
    const result = executeJsTool({ code: 'console.log("a", "b", "c")' })
    expect(result.stdout).toBe('a b c')
  })
})

describe('execute_js — Sandbox Security', () => {
  it('cannot access require', () => {
    const result = executeJsTool({ code: 'require("fs")' })
    expect(result.error).toBeDefined()
  })

  it('cannot access process', () => {
    const result = executeJsTool({ code: 'process.env' })
    expect(result.error).toBeDefined()
  })

  it('cannot access Buffer', () => {
    const result = executeJsTool({ code: 'Buffer.from("test")' })
    expect(result.error).toBeDefined()
  })

  it('cannot access globalThis', () => {
    const result = executeJsTool({ code: 'globalThis.constructor' })
    expect(result.error).toBeDefined()
  })

  it('cannot use setTimeout', () => {
    const result = executeJsTool({ code: 'setTimeout(() => {}, 100)' })
    expect(result.error).toBeDefined()
  })

  it('cannot use setInterval', () => {
    const result = executeJsTool({ code: 'setInterval(() => {}, 100)' })
    expect(result.error).toBeDefined()
  })

  it('cannot access __dirname', () => {
    const result = executeJsTool({ code: '__dirname' })
    expect(result.error).toBeDefined()
  })

  it('cannot access __filename', () => {
    const result = executeJsTool({ code: '__filename' })
    expect(result.error).toBeDefined()
  })

  it('cannot read or write files from sandbox', () => {
    // Even with eval/Function, fs access is blocked
    const result = executeJsTool({ code: 'const fn = new Function("return typeof require"); fn()' })
    // require is undefined in sandbox, so Function body sees sandbox scope
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('undefined')
  })
})

describe('execute_js — Error Handling', () => {
  it('returns error for syntax errors', () => {
    const result = executeJsTool({ code: 'function {invalid' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('Unexpected')
  })

  it('returns error for runtime exceptions', () => {
    const result = executeJsTool({ code: 'throw new Error("boom")' })
    expect(result.error).toBe('boom')
  })

  it('returns partial stdout on error', () => {
    const result = executeJsTool({ code: 'console.log("before"); throw new Error("fail"); console.log("after")' })
    expect(result.stdout).toBe('before')
    expect(result.error).toBe('fail')
  })

  it('handles timeout (infinite loop)', () => {
    const result = executeJsTool({ code: 'while(true) {}' })
    expect(result.error).toBeDefined()
    expect(result.error?.toLowerCase()).toContain('timed out')
  }, 10000)

  it('handles undefined variable access', () => {
    const result = executeJsTool({ code: 'nonExistentVar.property' })
    expect(result.error).toBeDefined()
  })

  it('handles division by zero (returns Infinity, not error)', () => {
    const result = executeJsTool({ code: '1 / 0' })
    expect(result.result).toBe('Infinity')
    expect(result.error).toBeUndefined()
  })
})

describe('execute_js — Safe Built-ins', () => {
  it('Math functions work', () => {
    const result = executeJsTool({ code: 'Math.max(1, 5, 3)' })
    expect(result.result).toBe('5')
  })

  it('Date constructor works', () => {
    const result = executeJsTool({ code: 'new Date(0).toISOString()' })
    expect(result.result).toBe('1970-01-01T00:00:00.000Z')
  })

  it('JSON.parse/stringify work', () => {
    const result = executeJsTool({ code: 'JSON.stringify(JSON.parse(\'{"a":1}\'))' })
    expect(result.result).toBe('{"a":1}')
  })

  it('Array methods work', () => {
    const result = executeJsTool({ code: '[3,1,2].sort().join(",")' })
    expect(result.result).toBe('1,2,3')
  })

  it('Object methods work', () => {
    const result = executeJsTool({ code: 'Object.keys({a:1, b:2}).length' })
    expect(result.result).toBe('2')
  })

  it('Map works', () => {
    const result = executeJsTool({ code: 'const m = new Map(); m.set("k", "v"); m.get("k")' })
    expect(result.result).toBe('v')
  })

  it('Set works', () => {
    const result = executeJsTool({ code: 'new Set([1,2,2,3]).size' })
    expect(result.result).toBe('3')
  })

  it('RegExp works', () => {
    const result = executeJsTool({ code: '/hello/.test("hello world")' })
    expect(result.result).toBe('true')
  })

  it('String methods work', () => {
    const result = executeJsTool({ code: '"Hello World".toLowerCase().split(" ").length' })
    expect(result.result).toBe('2')
  })

  it('parseInt/parseFloat work', () => {
    const result = executeJsTool({ code: 'parseInt("42") + parseFloat("0.5")' })
    expect(result.result).toBe('42.5')
  })

  it('Symbol works', () => {
    const result = executeJsTool({ code: 'typeof Symbol("test")' })
    expect(result.result).toBe('symbol')
  })

  it('isNaN/isFinite work', () => {
    const result = executeJsTool({ code: 'isNaN(NaN) && isFinite(42)' })
    expect(result.result).toBe('true')
  })
})
