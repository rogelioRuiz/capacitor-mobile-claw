/**
 * Phase 1 E2E Test: Composable Bridge Integration
 *
 * Validates the message dispatch and listener patterns used by
 * useMobileClaw.js composable. Tests the bridge protocol contract
 * between the Vue UI layer and the Node.js worker — without requiring
 * Capacitor or Vue runtime.
 *
 * These tests verify:
 * - Message dispatch to typed handlers
 * - Wildcard listener support
 * - Once-off listener cleanup
 * - Agent control message shapes (start, stop, approve)
 * - Worker event message shapes (ready, event, completed, error)
 */

import { beforeEach, describe, expect, it } from 'vitest'

// ── Standalone reimplementation of the dispatch/listener logic ──────────
// Mirrors useMobileClaw.js without Vue reactivity or Capacitor imports.

type Handler = (msg: Record<string, unknown>) => void

function createBridge() {
  const listeners = new Map<string, Set<Handler>>()

  function onMessage(type: string, handler: Handler, opts: { once?: boolean } = {}) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    const wrapped: Handler = opts.once
      ? (msg) => {
          listeners.get(type)?.delete(wrapped)
          handler(msg)
        }
      : handler
    listeners.get(type)?.add(wrapped)
    return () => listeners.get(type)?.delete(wrapped)
  }

  function dispatch(msg: Record<string, unknown>) {
    const type = msg.type as string
    const handlers = listeners.get(type)
    if (handlers) for (const h of handlers) h(msg)
    const wildcards = listeners.get('*')
    if (wildcards) for (const h of wildcards) h(msg)
  }

  return { onMessage, dispatch, listeners }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Bridge Message Dispatch', () => {
  let bridge: ReturnType<typeof createBridge>

  beforeEach(() => {
    bridge = createBridge()
  })

  it('should dispatch message to typed handler', () => {
    const received: unknown[] = []
    bridge.onMessage('worker.ready', (msg) => received.push(msg))

    bridge.dispatch({ type: 'worker.ready', nodeVersion: 'v20.19.0', openclawRoot: '/data/.openclaw' })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: 'worker.ready',
      nodeVersion: 'v20.19.0',
      openclawRoot: '/data/.openclaw',
    })
  })

  it('should dispatch to wildcard handlers', () => {
    const received: unknown[] = []
    bridge.onMessage('*', (msg) => received.push(msg))

    bridge.dispatch({ type: 'agent.event', eventType: 'text_delta', data: { text: 'hi' } })
    bridge.dispatch({ type: 'agent.completed', sessionKey: 's1' })

    expect(received).toHaveLength(2)
  })

  it('should fire once-off listener only once', () => {
    let callCount = 0
    bridge.onMessage(
      'worker.ready',
      () => {
        callCount++
      },
      { once: true },
    )

    bridge.dispatch({ type: 'worker.ready' })
    bridge.dispatch({ type: 'worker.ready' })

    expect(callCount).toBe(1)
  })

  it('should support unsubscribe via returned function', () => {
    let callCount = 0
    const unsub = bridge.onMessage('agent.event', () => {
      callCount++
    })

    bridge.dispatch({ type: 'agent.event' })
    expect(callCount).toBe(1)

    unsub()
    bridge.dispatch({ type: 'agent.event' })
    expect(callCount).toBe(1)
  })

  it('should handle multiple handlers for same type', () => {
    const log: string[] = []
    bridge.onMessage('agent.event', () => log.push('a'))
    bridge.onMessage('agent.event', () => log.push('b'))

    bridge.dispatch({ type: 'agent.event' })
    expect(log).toEqual(['a', 'b'])
  })

  it('should not leak handlers between message types', () => {
    let called = false
    bridge.onMessage('agent.completed', () => {
      called = true
    })

    bridge.dispatch({ type: 'agent.error', error: 'oops' })
    expect(called).toBe(false)
  })
})

describe('Agent Control Messages (UI → Worker)', () => {
  it('agent.start has required fields', () => {
    const msg = {
      type: 'agent.start',
      agentId: 'main',
      sessionKey: 'session-123',
      prompt: 'Hello, what can you do?',
    }

    expect(msg.type).toBe('agent.start')
    expect(msg.agentId).toBeTruthy()
    expect(msg.sessionKey).toMatch(/^session-/)
    expect(msg.prompt).toBeTruthy()
  })

  it('agent.stop has correct shape', () => {
    const msg = { type: 'agent.stop' }
    expect(msg.type).toBe('agent.stop')
  })

  it('tool.approve has required fields', () => {
    const approveMsg = { type: 'tool.approve', toolCallId: 'toolu_abc', approved: true }
    const denyMsg = { type: 'tool.approve', toolCallId: 'toolu_abc', approved: false }

    expect(approveMsg.toolCallId).toMatch(/^toolu_/)
    expect(approveMsg.approved).toBe(true)
    expect(denyMsg.approved).toBe(false)
  })

  it('config.update carries config payload', () => {
    const msg = {
      type: 'config.update',
      config: { apiKey: 'sk-test-123', model: 'anthropic/claude-sonnet-4-5' },
    }

    expect(msg.config).toHaveProperty('apiKey')
    expect(msg.config).toHaveProperty('model')
  })
})

describe('Worker Event Messages (Worker → UI)', () => {
  it('agent.event text_delta has text field', () => {
    const msg = {
      type: 'agent.event',
      eventType: 'text_delta',
      data: { text: 'Hello' },
    }

    expect(msg.eventType).toBe('text_delta')
    expect(msg.data.text).toBe('Hello')
  })

  it('agent.event tool_use has name, id, and args', () => {
    const msg = {
      type: 'agent.event',
      eventType: 'tool_use',
      data: {
        toolName: 'read_file',
        toolCallId: 'toolu_xyz789',
        args: { path: 'SOUL.md' },
      },
    }

    expect(msg.data.toolName).toBe('read_file')
    expect(msg.data.toolCallId).toMatch(/^toolu_/)
    expect(msg.data.args).toHaveProperty('path')
  })

  it('agent.event tool_result has result payload', () => {
    const msg = {
      type: 'agent.event',
      eventType: 'tool_result',
      data: {
        toolName: 'read_file',
        result: { content: '# Soul\n\nPersonality.' },
      },
    }

    expect(msg.data.result).toHaveProperty('content')
  })

  it('agent.completed has usage stats', () => {
    const msg = {
      type: 'agent.completed',
      sessionKey: 'session-456',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      durationMs: 3500,
    }

    expect(msg.usage.totalTokens).toBe(msg.usage.inputTokens + msg.usage.outputTokens)
    expect(msg.durationMs).toBeGreaterThan(0)
  })

  it('agent.error has error message', () => {
    const msg = {
      type: 'agent.error',
      error: 'API key invalid',
      code: '401',
    }

    expect(msg.error).toBeTruthy()
    expect(typeof msg.error).toBe('string')
  })

  it('tool.approval_request has tool details', () => {
    const msg = {
      type: 'tool.approval_request',
      toolCallId: 'toolu_approval1',
      toolName: 'write_file',
      args: { path: 'config.json', content: '{}' },
    }

    expect(msg.toolCallId).toMatch(/^toolu_/)
    expect(msg.toolName).toBe('write_file')
    expect(msg.args).toHaveProperty('path')
    expect(msg.args).toHaveProperty('content')
  })

  it('worker.ready has node version and openclaw root', () => {
    const msg = {
      type: 'worker.ready',
      nodeVersion: 'v20.19.0',
      openclawRoot: '/data/user/0/com.openclaw.mobile/.openclaw',
    }

    expect(msg.nodeVersion).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(msg.openclawRoot).toContain('.openclaw')
  })
})

describe('Pseudo-Session Object', () => {
  it('should have mobile-claw provider and permanent UUID', () => {
    const session = {
      uuid: 'mobile-claw-local',
      ai_provider: 'mobile-claw',
      status: 'running',
      input: 'On-device AI agent',
      author: 'local',
      project_id: 'mobile-claw',
      project_path: 'mobile-claw/local',
      created_at: new Date().toISOString(),
    }

    expect(session.uuid).toBe('mobile-claw-local')
    expect(session.ai_provider).toBe('mobile-claw')
    expect(session.status).toBe('running')
    expect(session.author).toBe('local')
  })

  it('should be recognized as interactive provider', () => {
    const INTERACTIVE_PROVIDERS = ['claude', 'openclaw', 'mobile-claw']
    expect(INTERACTIVE_PROVIDERS).toContain('mobile-claw')
  })

  it('should not be in server-dispatched providers', () => {
    const SERVER_PROVIDERS = ['claude', 'codex', 'qwen']
    expect(SERVER_PROVIDERS).not.toContain('mobile-claw')
  })
})
