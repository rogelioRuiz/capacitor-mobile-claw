import { afterEach, describe, expect, it, vi } from 'vitest'

const saveSessionMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../src/agent/session-store', () => ({
  SessionStore: class {
    saveSession = saveSessionMock
  },
}))

// Configurable mock — tests can change the response text per run
let _mockResponseText = 'Background alert'
let _mockRunCalls: any[] = []
let _mockShouldThrow: string | null = null

vi.mock('../../src/agent/agent-runner', () => ({
  AgentRunner: class {
    currentAgent: any = null
    _config: any

    constructor(config: any) {
      this._config = config
    }

    async run(params: any) {
      _mockRunCalls.push({ ...params, _configHasPreExecute: !!this._config.preExecuteHook })

      if (_mockShouldThrow) {
        throw new Error(_mockShouldThrow)
      }

      this.currentAgent = {
        state: {
          messages: [
            { role: 'user', content: params.prompt },
            {
              role: 'assistant',
              content: [{ type: 'text', text: _mockResponseText }],
              usage: { input: 10, output: 5 },
            },
          ],
        },
      }
    }

    abort() {}
  },
}))

import {
  buildHeartbeatPrompt,
  computeNextRunAt,
  errorBackoffMs,
  fnv1aHash,
  HeartbeatManager,
  isHeartbeatOk,
  isWithinActiveHours,
} from '../../src/agent/heartbeat-manager'

function createCronDb(overrides: Record<string, any> = {}) {
  return {
    getSchedulerConfig: vi.fn(async () => ({ enabled: true, schedulingMode: 'balanced', runOnCharging: true })),
    getHeartbeatConfig: vi.fn(async () => ({ enabled: true, everyMs: 1_000, prompt: 'Check in' })),
    setHeartbeatConfig: vi.fn(async () => ({ enabled: true, everyMs: 1_000 })),
    listCronSkills: vi.fn(async () => []),
    listCronJobs: vi.fn(async () => []),
    getDueJobs: vi.fn(async () => []),
    updateCronJob: vi.fn(async () => {}),
    insertCronRun: vi.fn(async () => 1),
    peekPendingEvents: vi.fn(async () => []),
    consumePendingEvents: vi.fn(async () => {}),
    enqueueSystemEvent: vi.fn(async () => {}),
    getMaxMessageSequence: vi.fn(async () => -1),
    deleteMessagesAfter: vi.fn(async () => {}),
    ...overrides,
  }
}

function createManager(cronDb: any, overrides: Record<string, any> = {}) {
  const dispatched: any[] = []
  const manager = new HeartbeatManager({
    dispatch: (msg) => dispatched.push(msg),
    toolProxy: {} as any,
    cronDb: cronDb as any,
    getAuth: vi.fn(async () => ({ apiKey: 'sk-test' })),
    getSystemPrompt: vi.fn(async () => ({ systemPrompt: 'System prompt' })),
    isUserAgentRunning: () => false,
    getCurrentSessionKey: () => 'main-session',
    ...overrides,
  })
  return { manager, dispatched }
}

describe('HeartbeatManager', () => {
  afterEach(() => {
    vi.clearAllMocks()
    _mockResponseText = 'Background alert'
    _mockRunCalls = []
    _mockShouldThrow = null
  })

  it('skips scheduled wakes when the scheduler is disabled', async () => {
    const cronDb = createCronDb({
      getSchedulerConfig: vi.fn(async () => ({ enabled: false, schedulingMode: 'balanced', runOnCharging: true })),
      getHeartbeatConfig: vi.fn(async () => ({ enabled: false, everyMs: 1_000 })),
      getDueJobs: vi.fn(async () => []),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('mobilecron')

    expect(dispatched.find((msg) => msg.type === 'heartbeat.skipped')?.reason).toBe('scheduler_disabled')
    expect(dispatched.find((msg) => msg.type === 'scheduler.status')).toBeDefined()
  })

  it('runs an isolated heartbeat turn and emits completion events', async () => {
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((msg) => msg.type === 'heartbeat.started')).toBeDefined()
    expect(dispatched.find((msg) => msg.type === 'cron.notification')?.body).toBe('Background alert')
    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')?.status).toBe('ok')
    expect(saveSessionMock).toHaveBeenCalledTimes(1)
    expect(cronDb.setHeartbeatConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        lastHash: expect.any(String),
      }),
    )
  })

  it('builds heartbeat prompts with pending system events', () => {
    const prompt = buildHeartbeatPrompt('Base prompt', [
      {
        id: 1,
        sessionKey: 'main',
        contextKey: 'cron:test',
        text: 'Run this check',
        createdAt: Date.UTC(2026, 1, 28, 12, 0, 0),
        consumed: false,
      },
    ])

    expect(prompt).toContain('Base prompt')
    expect(prompt).toContain('System events:')
    expect(prompt).toContain('cron:test')
    expect(prompt).toContain('Run this check')
  })

  // ── Dedup logic ────────────────────────────────────────────────────────

  it('deduplicates identical responses within the 24h window', async () => {
    const hash = fnv1aHash('Background alert')
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: Date.now() - 60_000, // 1 minute ago (within 24h window)
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const completed = dispatched.find((msg) => msg.type === 'heartbeat.completed')
    expect(completed?.status).toBe('deduped')
    expect(completed?.reason).toBe('duplicate')
    expect(saveSessionMock).not.toHaveBeenCalled()
  })

  it('does NOT dedup if the hash differs', async () => {
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: 'different-hash',
        lastSentAt: Date.now() - 60_000,
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')?.status).toBe('ok')
    expect(saveSessionMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT dedup if lastSentAt is older than 24h', async () => {
    const hash = fnv1aHash('Background alert')
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')?.status).toBe('ok')
  })

  // ── HEARTBEAT_OK suppression ───────────────────────────────────────────

  it('suppresses HEARTBEAT_OK responses', async () => {
    _mockResponseText = 'HEARTBEAT_OK'
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')?.status).toBe('suppressed')
    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')?.reason).toBe('heartbeat_ok')
    expect(saveSessionMock).not.toHaveBeenCalled()
  })

  // ── Error backoff ──────────────────────────────────────────────────────

  it('applies error backoff on agent failure', async () => {
    _mockShouldThrow = 'API rate limited'
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const completed = dispatched.find((msg) => msg.type === 'heartbeat.completed')
    expect(completed?.status).toBe('error')
    expect(completed?.reason).toContain('API rate limited')

    // nextRunAt should use error backoff (30s for first error)
    const setCall = cronDb.setHeartbeatConfig.mock.calls[0]?.[0]
    expect(setCall?.nextRunAt).toBeDefined()
    // First error backoff is 30_000ms
    expect(setCall.nextRunAt).toBeGreaterThanOrEqual(Date.now() + 25_000)
  })

  // ── Skill constraint propagation ───────────────────────────────────────

  it('passes skill constraints (allowedTools, systemPrompt, maxTurns) to AgentRunner', async () => {
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        skillId: 'skill-1',
      })),
      listCronSkills: vi.fn(async () => [
        {
          id: 'skill-1',
          name: 'test-skill',
          allowedTools: ['Read', 'Write'],
          systemPrompt: 'You are a monitor.',
          model: 'claude-opus-4-5',
          maxTurns: 2,
          timeoutMs: 15_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(_mockRunCalls.length).toBe(1)
    const call = _mockRunCalls[0]
    expect(call.allowedTools).toEqual(['Read', 'Write'])
    expect(call.systemPrompt).toBe('You are a monitor.')
    expect(call.model).toBe('claude-opus-4-5')
    expect(call.maxTurns).toBe(2)
    // No preExecuteHook → auto-approve
    expect(call._configHasPreExecute).toBe(false)
  })

  // ── User active skip ───────────────────────────────────────────────────

  it('skips when user agent is running (non-manual)', async () => {
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb, {
      isUserAgentRunning: () => true,
    })

    await manager.handleWake('mobilecron')

    expect(dispatched.find((msg) => msg.type === 'heartbeat.skipped')?.reason).toBe('user_active')
  })

  it('does NOT skip user active for manual wakes', async () => {
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb, {
      isUserAgentRunning: () => true,
    })

    await manager.handleWake('manual')

    expect(dispatched.find((msg) => msg.type === 'heartbeat.started')).toBeDefined()
    expect(dispatched.find((msg) => msg.type === 'heartbeat.completed')).toBeDefined()
  })

  // ── Cron job with sessionTarget='main' ─────────────────────────────────

  it('enqueues system event for main-target cron jobs', async () => {
    _mockResponseText = 'HEARTBEAT_OK'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        {
          id: 'job-main',
          name: 'main-job',
          enabled: true,
          sessionTarget: 'main',
          wakeMode: 'next-heartbeat',
          schedule: { kind: 'every', everyMs: 60_000 },
          skillId: null,
          prompt: 'Check system status',
          deliveryMode: 'notification',
          consecutiveErrors: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listCronJobs: vi.fn(async () => []),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(cronDb.enqueueSystemEvent).toHaveBeenCalledWith(
      'main-session',
      expect.stringContaining('cron:job-main:'),
      'Check system status',
    )
    expect(dispatched.find((msg) => msg.type === 'cron.job.started')?.jobId).toBe('job-main')
    expect(dispatched.find((msg) => msg.type === 'cron.job.completed')?.jobId).toBe('job-main')
    expect(cronDb.updateCronJob).toHaveBeenCalledWith('job-main', expect.objectContaining({ lastRunStatus: 'ok' }))
    expect(cronDb.insertCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-main', status: 'ok' }))
  })

  // ── Cron job with sessionTarget='isolated' ─────────────────────────────

  it('runs isolated cron jobs with their own agent turn', async () => {
    _mockResponseText = 'Job completed successfully'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        {
          id: 'job-iso',
          name: 'isolated-job',
          enabled: true,
          sessionTarget: 'isolated',
          wakeMode: 'next-heartbeat',
          schedule: { kind: 'every', everyMs: 60_000 },
          skillId: null,
          prompt: 'Run isolated check',
          deliveryMode: 'notification',
          consecutiveErrors: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listCronJobs: vi.fn(async () => []),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // Should have run 2 agent turns: heartbeat + cron job
    expect(_mockRunCalls.length).toBe(2)

    const cronRunCall = _mockRunCalls.find((c: any) => c.prompt === 'Run isolated check')
    expect(cronRunCall).toBeDefined()
    expect(cronRunCall.sessionKey).toContain('cron/job-iso/')

    expect(dispatched.find((msg) => msg.type === 'cron.job.completed')?.jobId).toBe('job-iso')
    expect(cronDb.insertCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-iso' }))
  })
})

// ── Utility function tests ─────────────────────────────────────────────────

describe('Utility functions', () => {
  it('fnv1aHash produces consistent hashes', () => {
    expect(fnv1aHash('hello')).toBe(fnv1aHash('hello'))
    expect(fnv1aHash('hello')).not.toBe(fnv1aHash('world'))
    expect(typeof fnv1aHash('test')).toBe('string')
    expect(fnv1aHash('test').length).toBe(8) // 8 hex chars
  })

  it('isHeartbeatOk detects OK tokens', () => {
    expect(isHeartbeatOk('HEARTBEAT_OK')).toBe(true)
    expect(isHeartbeatOk('heartbeat_ok')).toBe(true)
    expect(isHeartbeatOk('ok')).toBe(true)
    expect(isHeartbeatOk('OK')).toBe(true)
    expect(isHeartbeatOk('✓')).toBe(true)
    expect(isHeartbeatOk('👍')).toBe(true)
    expect(isHeartbeatOk('')).toBe(true) // empty = ok
    expect(isHeartbeatOk('Something else')).toBe(false)
    expect(isHeartbeatOk('HEARTBEAT_OK\nExtra text')).toBe(true)
  })

  it('errorBackoffMs returns escalating delays', () => {
    expect(errorBackoffMs(1)).toBe(30_000)
    expect(errorBackoffMs(2)).toBe(60_000)
    expect(errorBackoffMs(3)).toBe(300_000)
    expect(errorBackoffMs(4)).toBe(900_000)
    expect(errorBackoffMs(5)).toBe(3_600_000)
    // Clamps at max
    expect(errorBackoffMs(100)).toBe(3_600_000)
  })

  it('isWithinActiveHours handles normal ranges', () => {
    // 09:00-17:00 UTC, at 12:00 UTC
    const noon = new Date('2026-02-28T12:00:00Z').getTime()
    expect(isWithinActiveHours('09:00', '17:00', 'UTC', noon)).toBe(true)

    // At 08:00 UTC — outside
    const early = new Date('2026-02-28T08:00:00Z').getTime()
    expect(isWithinActiveHours('09:00', '17:00', 'UTC', early)).toBe(false)

    // No active hours = always active
    expect(isWithinActiveHours(undefined, undefined, undefined, noon)).toBe(true)
  })

  it('computeNextRunAt handles every schedule', () => {
    const now = 1000000
    expect(computeNextRunAt({ schedule: { kind: 'every', everyMs: 60000 } }, now)).toBe(1060000)
    expect(computeNextRunAt({ schedule: { kind: 'every', everyMs: 0 } }, now)).toBe(null)
  })

  it('computeNextRunAt handles at schedule', () => {
    const now = 1000000
    expect(computeNextRunAt({ schedule: { kind: 'at', atMs: 2000000 } }, now)).toBe(2000000)
    // Past time → null
    expect(computeNextRunAt({ schedule: { kind: 'at', atMs: 500000 } }, now)).toBe(null)
  })
})
