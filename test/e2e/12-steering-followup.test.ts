/**
 * Phase 4 E2E Test: Steering, Follow-Up, and Memory Write-Back
 *
 * Verifies:
 * - Steering messages queue via agent.steer()
 * - Follow-up messages queue via agent.followUp()
 * - Steering and follow-up queues can be cleared
 * - agent.steer message type in bridge protocol
 * - Memory write-back via write_file to MEMORY.md
 * - Session clear clears agent messages
 * - Agent state management across operations
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TEST_ROOT = join(process.cwd(), '.test-steering')
const WORKSPACE = join(TEST_ROOT, 'workspace')

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  writeFileSync(join(WORKSPACE, 'MEMORY.md'), '# Memory\n\nInitial content.\n')
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function createTestAgent() {
  const model = getModel('anthropic', 'claude-sonnet-4-5')
  return new Agent({
    initialState: {
      systemPrompt: 'Test',
      model,
      tools: [],
      thinkingLevel: 'off',
    },
    convertToLlm: (messages) =>
      messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
  })
}

describe('Steering - Queue Management', () => {
  it('steer queues a user message', () => {
    const agent = createTestAgent()
    agent.steer({ role: 'user', content: 'change direction', timestamp: Date.now() })
    expect(agent.hasQueuedMessages()).toBe(true)
  })

  it('multiple steers queue multiple messages', () => {
    const agent = createTestAgent()
    agent.steer({ role: 'user', content: 'first', timestamp: Date.now() })
    agent.steer({ role: 'user', content: 'second', timestamp: Date.now() })
    expect(agent.hasQueuedMessages()).toBe(true)
  })

  it('clearSteeringQueue empties the queue', () => {
    const agent = createTestAgent()
    agent.steer({ role: 'user', content: 'will be cleared', timestamp: Date.now() })
    agent.clearSteeringQueue()
    // After clearing steering, hasQueued depends on followUp too
    // But if no followUp, should be false
    expect(agent.hasQueuedMessages()).toBe(false)
  })

  it('clearAllQueues clears both steering and follow-up', () => {
    const agent = createTestAgent()
    agent.steer({ role: 'user', content: 'steer', timestamp: Date.now() })
    agent.followUp({ role: 'user', content: 'followup', timestamp: Date.now() })
    expect(agent.hasQueuedMessages()).toBe(true)
    agent.clearAllQueues()
    expect(agent.hasQueuedMessages()).toBe(false)
  })
})

describe('Follow-Up - Queue Management', () => {
  it('followUp queues a message', () => {
    const agent = createTestAgent()
    agent.followUp({ role: 'user', content: 'follow up question', timestamp: Date.now() })
    expect(agent.hasQueuedMessages()).toBe(true)
  })

  it('clearFollowUpQueue empties follow-up queue', () => {
    const agent = createTestAgent()
    agent.followUp({ role: 'user', content: 'will be cleared', timestamp: Date.now() })
    agent.clearFollowUpQueue()
    expect(agent.hasQueuedMessages()).toBe(false)
  })

  it('followUp does not affect steering queue', () => {
    const agent = createTestAgent()
    agent.steer({ role: 'user', content: 'steer msg', timestamp: Date.now() })
    agent.clearFollowUpQueue()
    // Steering should still be queued
    expect(agent.hasQueuedMessages()).toBe(true)
    agent.clearAllQueues()
  })
})

describe('Agent State Management', () => {
  it('clearMessages resets message array', () => {
    const agent = createTestAgent()
    agent.appendMessage({ role: 'user', content: 'test', timestamp: Date.now() } as any)
    expect(agent.state.messages.length).toBeGreaterThan(0)
    agent.clearMessages()
    expect(agent.state.messages).toHaveLength(0)
  })

  it('appendMessage adds to messages', () => {
    const agent = createTestAgent()
    const msg = { role: 'user', content: 'hello', timestamp: Date.now() } as any
    agent.appendMessage(msg)
    expect(agent.state.messages).toHaveLength(1)
    expect((agent.state.messages[0] as any).content).toBe('hello')
  })

  it('replaceMessages replaces entire array', () => {
    const agent = createTestAgent()
    agent.appendMessage({ role: 'user', content: 'old', timestamp: Date.now() } as any)
    const newMessages = [
      { role: 'user', content: 'new1', timestamp: Date.now() } as any,
      { role: 'user', content: 'new2', timestamp: Date.now() } as any,
    ]
    agent.replaceMessages(newMessages)
    expect(agent.state.messages).toHaveLength(2)
    expect((agent.state.messages[0] as any).content).toBe('new1')
  })

  it('setSystemPrompt updates system prompt', () => {
    const agent = createTestAgent()
    agent.setSystemPrompt('New system prompt')
    expect(agent.state.systemPrompt).toBe('New system prompt')
  })

  it('setModel updates model', () => {
    const agent = createTestAgent()
    const newModel = getModel('anthropic', 'claude-sonnet-4-5')
    agent.setModel(newModel)
    expect(agent.state.model).toBe(newModel)
  })

  it('abort does not throw when not streaming', () => {
    const agent = createTestAgent()
    expect(() => agent.abort()).not.toThrow()
  })

  it('reset clears everything', () => {
    const agent = createTestAgent()
    agent.appendMessage({ role: 'user', content: 'test', timestamp: Date.now() } as any)
    agent.steer({ role: 'user', content: 'steer', timestamp: Date.now() })
    agent.reset()
    expect(agent.state.messages).toHaveLength(0)
    expect(agent.hasQueuedMessages()).toBe(false)
  })
})

describe('Bridge Protocol - agent.steer Message', () => {
  it('agent.steer message has required fields', () => {
    const steerMsg = { type: 'agent.steer', text: 'Change approach' }
    expect(steerMsg.type).toBe('agent.steer')
    expect(steerMsg.text).toBe('Change approach')
  })

  it('steering message converts to user role', () => {
    // In main.js, agent.steer handler creates: { role: 'user', content: msg.text, timestamp: ... }
    const msg = { type: 'agent.steer', text: 'use a different algorithm' }
    const agentMessage = { role: 'user', content: msg.text, timestamp: Date.now() }
    expect(agentMessage.role).toBe('user')
    expect(agentMessage.content).toBe('use a different algorithm')
    expect(typeof agentMessage.timestamp).toBe('number')
  })
})

describe('Memory Write-Back', () => {
  beforeEach(() => {
    writeFileSync(join(WORKSPACE, 'MEMORY.md'), '# Memory\n\nInitial content.\n')
  })

  it('MEMORY.md exists in workspace', () => {
    expect(existsSync(join(WORKSPACE, 'MEMORY.md'))).toBe(true)
  })

  it('MEMORY.md can be read', () => {
    const content = readFileSync(join(WORKSPACE, 'MEMORY.md'), 'utf8')
    expect(content).toContain('# Memory')
    expect(content).toContain('Initial content.')
  })

  it('MEMORY.md can be updated (simulating write_file tool)', () => {
    const newContent = '# Memory\n\nInitial content.\n\n## Updated\n\n- User prefers TypeScript\n'
    writeFileSync(join(WORKSPACE, 'MEMORY.md'), newContent)

    const content = readFileSync(join(WORKSPACE, 'MEMORY.md'), 'utf8')
    expect(content).toContain('User prefers TypeScript')
  })

  it('updated MEMORY.md persists across reads', () => {
    const newContent = '# Memory\n\nPersisted update.\n'
    writeFileSync(join(WORKSPACE, 'MEMORY.md'), newContent)

    // Simulate a new session loading MEMORY.md
    const loaded = readFileSync(join(WORKSPACE, 'MEMORY.md'), 'utf8')
    expect(loaded).toBe(newContent)
  })

  it('MEMORY.md is included in system prompt construction', () => {
    writeFileSync(join(WORKSPACE, 'SOUL.md'), '# Soul\n\nYou are helpful.\n')
    writeFileSync(join(WORKSPACE, 'MEMORY.md'), '# Memory\n\nRemember: user likes Python.\n')

    // Simulate loadSystemPrompt logic
    let systemPrompt = ''
    if (existsSync(join(WORKSPACE, 'SOUL.md'))) {
      systemPrompt += `${readFileSync(join(WORKSPACE, 'SOUL.md'), 'utf8')}\n\n`
    }
    if (existsSync(join(WORKSPACE, 'MEMORY.md'))) {
      systemPrompt += `## Memory\n${readFileSync(join(WORKSPACE, 'MEMORY.md'), 'utf8')}\n\n`
    }

    expect(systemPrompt).toContain('You are helpful.')
    expect(systemPrompt).toContain('user likes Python')
  })
})

describe('Steering Mode', () => {
  it('default steering mode', () => {
    const agent = createTestAgent()
    // Agent has getSteeringMode method
    const mode = agent.getSteeringMode()
    expect(mode === 'all' || mode === 'one-at-a-time').toBe(true)
  })

  it('can set steering mode to one-at-a-time', () => {
    const agent = createTestAgent()
    agent.setSteeringMode('one-at-a-time')
    expect(agent.getSteeringMode()).toBe('one-at-a-time')
  })

  it('can set steering mode to all', () => {
    const agent = createTestAgent()
    agent.setSteeringMode('all')
    expect(agent.getSteeringMode()).toBe('all')
  })
})

describe('Follow-Up Mode', () => {
  it('default follow-up mode', () => {
    const agent = createTestAgent()
    const mode = agent.getFollowUpMode()
    expect(mode === 'all' || mode === 'one-at-a-time').toBe(true)
  })

  it('can set follow-up mode to one-at-a-time', () => {
    const agent = createTestAgent()
    agent.setFollowUpMode('one-at-a-time')
    expect(agent.getFollowUpMode()).toBe('one-at-a-time')
  })

  it('can set follow-up mode to all', () => {
    const agent = createTestAgent()
    agent.setFollowUpMode('all')
    expect(agent.getFollowUpMode()).toBe('all')
  })
})
