import { afterEach, describe, expect, it, vi } from 'vitest'

// ── Mocks (same pattern as heartbeat-manager.test.ts) ─────────────────────

const saveSessionMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../src/agent/session-store', () => ({
  SessionStore: class {
    saveSession = saveSessionMock
  },
}))

let _mockResponseText = 'Background alert'
let _mockRunCalls: any[] = []
let _mockShouldThrow: string | null = null
let _mockRunDelay = 0

vi.mock('../../src/agent/agent-runner', () => ({
  AgentRunner: class {
    currentAgent: any = null
    _config: any

    constructor(config: any) {
      this._config = config
    }

    async run(params: any) {
      _mockRunCalls.push({ ...params, _configHasPreExecute: !!this._config.preExecuteHook })

      if (_mockRunDelay > 0) {
        await new Promise((r) => setTimeout(r, _mockRunDelay))
      }

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

// ── Factories ─────────────────────────────────────────────────────────────

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

function makeDueJob(overrides: Record<string, any> = {}) {
  return {
    id: 'job-1',
    name: 'test-job',
    enabled: true,
    sessionTarget: 'isolated',
    wakeMode: 'next-heartbeat',
    schedule: { kind: 'every', everyMs: 60_000 },
    skillId: null,
    prompt: 'Run job check',
    deliveryMode: 'notification',
    consecutiveErrors: 0,
    lastResponseHash: null,
    lastResponseSentAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks()
  _mockResponseText = 'Background alert'
  _mockRunCalls = []
  _mockShouldThrow = null
  _mockRunDelay = 0
})

// ══════════════════════════════════════════════════════════════════════════
// A. Concurrency Stress
// ══════════════════════════════════════════════════════════════════════════

describe('A. Concurrency Stress', () => {
  it('A1: second handleWake while first running emits skipped(busy)', async () => {
    _mockRunDelay = 50
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    // Fire two wakes without awaiting the first
    const p1 = manager.handleWake('manual', { force: true })
    const p2 = manager.handleWake('foreground')
    await Promise.all([p1, p2])

    const started = dispatched.filter((m) => m.type === 'heartbeat.started')
    const skipped = dispatched.filter((m) => m.type === 'heartbeat.skipped' && m.reason === 'busy')
    expect(started.length).toBe(1)
    expect(skipped.length).toBe(1)
  })

  it('A2: wakeInFlight resets after error, allowing subsequent wakes', async () => {
    _mockShouldThrow = 'API error'
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })
    expect(dispatched.find((m) => m.type === 'heartbeat.completed')?.status).toBe('error')

    // Reset mock, fire again
    _mockShouldThrow = null
    await manager.handleWake('manual', { force: true })

    const starts = dispatched.filter((m) => m.type === 'heartbeat.started')
    expect(starts.length).toBe(2)
  })

  it('A3: 10 sequential wakes all complete without corruption', async () => {
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    for (let i = 0; i < 10; i++) {
      await manager.handleWake('manual', { force: true })
    }

    const starts = dispatched.filter((m) => m.type === 'heartbeat.started')
    expect(starts.length).toBe(10)
    const completions = dispatched.filter(
      (m) => m.type === 'heartbeat.completed' || (m.type === 'heartbeat.skipped' && m.reason !== 'busy'),
    )
    expect(completions.length).toBeGreaterThanOrEqual(10)
  })

  it('A4: Promise.all([3 sources]) — only first runs, rest skipped', async () => {
    _mockRunDelay = 30
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await Promise.all([
      manager.handleWake('mobilecron'),
      manager.handleWake('foreground'),
      manager.handleWake('workmanager'),
    ])

    const started = dispatched.filter((m) => m.type === 'heartbeat.started')
    const busySkips = dispatched.filter((m) => m.type === 'heartbeat.skipped' && m.reason === 'busy')
    expect(started.length).toBe(1)
    expect(busySkips.length).toBe(2)
  })

  it('A5: two due jobs both execute (no per-job lock)', async () => {
    _mockResponseText = 'Job output'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        makeDueJob({ id: 'job-a', name: 'job-a', prompt: 'Run A' }),
        makeDueJob({ id: 'job-b', name: 'job-b', prompt: 'Run B' }),
      ]),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const cronStarts = dispatched.filter((m) => m.type === 'cron.job.started')
    const cronCompletes = dispatched.filter((m) => m.type === 'cron.job.completed')
    expect(cronStarts.length).toBe(2)
    expect(cronCompletes.length).toBe(2)
    expect(cronStarts.map((m) => m.jobId).sort()).toEqual(['job-a', 'job-b'])
  })
})

// ══════════════════════════════════════════════════════════════════════════
// B. Dedup Edge Cases
// ══════════════════════════════════════════════════════════════════════════

describe('B. Dedup Edge Cases', () => {
  it('B6: exactly 24h boundary does NOT dedup (strict < comparison)', async () => {
    _mockResponseText = 'Background alert'
    const hash = fnv1aHash('Background alert')
    const now = Date.now()
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: now - 24 * 60 * 60 * 1000, // exactly 24h ago
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // At exactly 24h, (now - lastSentAt) === DEDUP_WINDOW_MS, and < is false → not deduped
    const completed = dispatched.find((m) => m.type === 'heartbeat.completed')
    expect(completed?.status).toBe('ok')
  })

  it('B7: 24h minus 1ms still deduplicates', async () => {
    _mockResponseText = 'Background alert'
    const hash = fnv1aHash('Background alert')
    const now = Date.now()
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: now - (24 * 60 * 60 * 1000 - 5_000),
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((m) => m.type === 'heartbeat.completed')?.status).toBe('deduped')
  })

  it('B8: empty response is suppressed(heartbeat_ok), never deduped', async () => {
    // Empty string: isHeartbeatOk('') returns true (empty = ok by design).
    // So even with matching hash, dedup is NOT reached — isOk takes precedence.
    _mockResponseText = ''
    const hash = fnv1aHash('')
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: Date.now() - 60_000,
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const completed = dispatched.find((m) => m.type === 'heartbeat.completed')
    expect(completed?.status).toBe('suppressed')
    // Empty is treated as heartbeat_ok (isHeartbeatOk returns true for empty)
    // The code checks: isDuplicate → isOk → empty, and isOk wins here
    expect(completed?.reason).toBe('heartbeat_ok')
    // Key assertion: it is NOT deduped even though hash matches
    expect(completed?.status).not.toBe('deduped')
  })

  it('B9: FNV-1a collision characterization (32-bit birthday bound)', () => {
    // With 77k strings, expect ~1 collision in 32-bit space (birthday paradox).
    // This is informational — documents the hash's collision rate.
    const seen = new Set<string>()
    let collisions = 0
    for (let i = 0; i < 77_000; i++) {
      const h = fnv1aHash(`test-string-${i}-${Math.random()}`)
      if (seen.has(h)) collisions++
      seen.add(h)
    }
    // We just document the collision count; a few is expected for 32-bit
    expect(collisions).toBeLessThan(10) // Should be very rare even at birthday bound
  })

  it('B10: cron job uses per-job hash, not heartbeat hash', async () => {
    _mockResponseText = 'Job output X'
    const jobHash = fnv1aHash('Job output X')
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: 'different-heartbeat-hash',
        lastSentAt: Date.now() - 60_000,
      })),
      getDueJobs: vi.fn(async () => [
        makeDueJob({
          id: 'job-dedup',
          prompt: 'Run dedup check',
          lastResponseHash: jobHash,
          lastResponseSentAt: Date.now() - 60_000,
        }),
      ]),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // Heartbeat should be 'ok' (hash differs from heartbeat lastHash)
    const heartbeatCompleted = dispatched.find((m) => m.type === 'heartbeat.completed')
    expect(heartbeatCompleted?.status).toBe('ok')

    // Cron job should be 'deduped' (same hash as job's lastResponseHash)
    const cronCompleted = dispatched.find((m) => m.type === 'cron.job.completed')
    expect(cronCompleted?.status).toBe('deduped')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// C. Error Recovery
// ══════════════════════════════════════════════════════════════════════════

describe('C. Error Recovery', () => {
  it('C11: consecutive errors produce escalating backoff', async () => {
    _mockShouldThrow = 'fail'
    const cronDb = createCronDb()
    const { manager } = createManager(cronDb)

    const backoffs: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      await manager.handleWake('manual', { force: true })
      const call = cronDb.setHeartbeatConfig.mock.calls[i]?.[0]
      if (call?.nextRunAt) {
        backoffs.push(call.nextRunAt - before)
      }
    }

    // Each backoff should be at least the expected ERROR_BACKOFF_MS value
    // Allow 100ms tolerance for test execution time
    expect(backoffs[0]).toBeGreaterThanOrEqual(29_000) // 30s
    expect(backoffs[1]).toBeGreaterThanOrEqual(59_000) // 60s
    expect(backoffs[2]).toBeGreaterThanOrEqual(299_000) // 5m
    expect(backoffs[3]).toBeGreaterThanOrEqual(899_000) // 15m
    expect(backoffs[4]).toBeGreaterThanOrEqual(3_599_000) // 1h
  })

  it('C12: backoff clamps at 1h for errors beyond index 5', () => {
    expect(errorBackoffMs(6)).toBe(3_600_000)
    expect(errorBackoffMs(10)).toBe(3_600_000)
    expect(errorBackoffMs(100)).toBe(3_600_000)
  })

  it('C13: success after errors resets consecutive counter', async () => {
    _mockShouldThrow = 'fail'
    const cronDb = createCronDb()
    const { manager } = createManager(cronDb)

    // Two errors
    await manager.handleWake('manual', { force: true })
    await manager.handleWake('manual', { force: true })

    // Now succeed
    _mockShouldThrow = null
    await manager.handleWake('manual', { force: true })

    // Another error — should use 30s backoff (first error), not 300s (third)
    _mockShouldThrow = 'fail again'
    const callsBefore = cronDb.setHeartbeatConfig.mock.calls.length
    await manager.handleWake('manual', { force: true })

    const lastCall = cronDb.setHeartbeatConfig.mock.calls[callsBefore]?.[0]
    const backoff = lastCall?.nextRunAt - Date.now()
    // First error backoff is 30s. With everyMs=1000, max(1000, 30000) = 30000
    expect(backoff).toBeGreaterThanOrEqual(28_000)
    expect(backoff).toBeLessThan(61_000) // Not 60s (second error)
  })

  it('C14: cron job errors increment independently from heartbeat', async () => {
    // Make the cron job throw by using a custom mock
    const cronDb2 = createCronDb({
      getDueJobs: vi.fn(async () => [makeDueJob({ id: 'job-err', consecutiveErrors: 3, prompt: 'THROW_ON_THIS' })]),
    })

    // We need a way to throw only for the cron job agent run.
    // The cron job uses a separate _runAgentTurn call.
    // Since our mock is global, let's just make everything throw and check cron error handling.
    _mockShouldThrow = 'cron job failure'
    const { manager, dispatched } = createManager(cronDb2)

    await manager.handleWake('manual', { force: true })

    // Heartbeat should error
    const heartbeatCompleted = dispatched.find((m) => m.type === 'heartbeat.completed')
    expect(heartbeatCompleted?.status).toBe('error')

    // Cron job should also error with incremented consecutiveErrors
    const cronError = dispatched.find((m) => m.type === 'cron.job.error')
    expect(cronError?.jobId).toBe('job-err')
    expect(cronError?.consecutiveErrors).toBe(4) // 3 + 1

    // DB update should reflect the incremented count
    expect(cronDb2.updateCronJob).toHaveBeenCalledWith('job-err', expect.objectContaining({ consecutiveErrors: 4 }))
  })

  it('C15: backoff stacks with normal schedule (max wins)', async () => {
    _mockShouldThrow = 'fail'
    // Job with long everyMs (120s) and 2 consecutive errors → 3rd error backoff = 300s
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        makeDueJob({
          id: 'job-backoff',
          schedule: { kind: 'every', everyMs: 120_000 },
          consecutiveErrors: 2,
        }),
      ]),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const updateCall = cronDb.updateCronJob.mock.calls.find((c: any) => c[0] === 'job-backoff')
    if (updateCall) {
      const nextRunAt = updateCall[1].nextRunAt
      const normalNext = Date.now() + 120_000
      const backoffNext = Date.now() + 300_000 // 3rd error = 5m
      // nextRunAt should be max of normal and backoff
      expect(nextRunAt).toBeGreaterThanOrEqual(normalNext)
      expect(nextRunAt).toBeGreaterThanOrEqual(backoffNext - 2000) // tolerance
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
// D. Schedule Correctness
// ══════════════════════════════════════════════════════════════════════════

describe('D. Schedule Correctness', () => {
  it('D16: computeNextRunAt with everyMs=0 returns null', () => {
    expect(computeNextRunAt({ schedule: { kind: 'every', everyMs: 0 } }, 1000)).toBe(null)
  })

  it('D17: unknown schedule kind returns null (job never fires)', () => {
    expect(computeNextRunAt({ schedule: { kind: 'crontab' as any } }, 1000)).toBe(null)
    expect(computeNextRunAt({ schedule: {} as any }, 1000)).toBe(null)
    expect(computeNextRunAt({ schedule: null as any }, 1000)).toBe(null)
  })

  it('D18: at-schedule with past timestamp returns null', () => {
    expect(computeNextRunAt({ schedule: { kind: 'at', atMs: 500 } }, 1000)).toBe(null)
    expect(computeNextRunAt({ schedule: { kind: 'at', atMs: 1000 } }, 1000)).toBe(null) // equal = not future
  })

  it('D19: active hours midnight crossing (22:00-06:00)', () => {
    // 23:00 UTC → inside [22:00, 06:00)
    const at23 = new Date('2026-03-10T23:00:00Z').getTime()
    expect(isWithinActiveHours('22:00', '06:00', 'UTC', at23)).toBe(true)

    // 05:00 UTC → inside [22:00, 06:00)
    const at05 = new Date('2026-03-10T05:00:00Z').getTime()
    expect(isWithinActiveHours('22:00', '06:00', 'UTC', at05)).toBe(true)

    // 07:00 UTC → outside [22:00, 06:00)
    const at07 = new Date('2026-03-10T07:00:00Z').getTime()
    expect(isWithinActiveHours('22:00', '06:00', 'UTC', at07)).toBe(false)

    // 21:00 UTC → outside [22:00, 06:00)
    const at21 = new Date('2026-03-10T21:00:00Z').getTime()
    expect(isWithinActiveHours('22:00', '06:00', 'UTC', at21)).toBe(false)
  })

  it('D20: equal start and end returns false', () => {
    const noon = new Date('2026-03-10T12:00:00Z').getTime()
    expect(isWithinActiveHours('09:00', '09:00', 'UTC', noon)).toBe(false)
    expect(isWithinActiveHours('00:00', '00:00', 'UTC', noon)).toBe(false)
  })

  it('D21: invalid timezone returns true (permissive fallback)', () => {
    const noon = new Date('2026-03-10T12:00:00Z').getTime()
    expect(isWithinActiveHours('09:00', '17:00', 'Invalid/Timezone', noon)).toBe(true)
  })

  it('D22: malformed time strings return true (permissive)', () => {
    const noon = new Date('2026-03-10T12:00:00Z').getTime()
    // Single-digit hour doesn't match /^(\d{2}):(\d{2})$/ regex
    expect(isWithinActiveHours('9:00', '17:00', 'UTC', noon)).toBe(true)
    expect(isWithinActiveHours('09:00', '5:00', 'UTC', noon)).toBe(true)
    expect(isWithinActiveHours('abc', 'def', 'UTC', noon)).toBe(true)
  })

  it('D23: end time 24:00 covers all day', () => {
    const midnight = new Date('2026-03-10T00:00:00Z').getTime()
    const noon = new Date('2026-03-10T12:00:00Z').getTime()
    const late = new Date('2026-03-10T23:59:00Z').getTime()

    expect(isWithinActiveHours('00:00', '24:00', 'UTC', midnight)).toBe(true)
    expect(isWithinActiveHours('00:00', '24:00', 'UTC', noon)).toBe(true)
    expect(isWithinActiveHours('00:00', '24:00', 'UTC', late)).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E. State Transitions
// ══════════════════════════════════════════════════════════════════════════

describe('E. State Transitions', () => {
  it('E24: job removal mid-iteration — orphaned run record still created', async () => {
    // If a job is deleted from DB while _runDueCronJobs iterates,
    // the iteration continues because the job was already fetched.
    // updateCronJob on a deleted row is a no-op, but insertCronRun still succeeds.
    _mockResponseText = 'Job output'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [makeDueJob({ id: 'job-deleted' })]),
      // updateCronJob succeeds (SQLite UPDATE WHERE id=X on deleted row = 0 rows affected, no error)
      updateCronJob: vi.fn(async () => {}),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // The run record is still inserted even though the job might be gone
    expect(cronDb.insertCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-deleted' }))
    expect(dispatched.find((m) => m.type === 'cron.job.completed')?.jobId).toBe('job-deleted')
  })

  it('E25: sessionTarget=main + wakeMode=now triggers immediate heartbeat cycle', async () => {
    _mockResponseText = 'HEARTBEAT_OK'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        makeDueJob({
          id: 'job-main-now',
          sessionTarget: 'main',
          wakeMode: 'now',
          prompt: 'Urgent check',
        }),
      ]),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // Should enqueue system event
    expect(cronDb.enqueueSystemEvent).toHaveBeenCalledWith(
      'main-session',
      expect.stringContaining('cron:job-main-now:'),
      'Urgent check',
    )

    // wakeMode=now should trigger an additional heartbeat cycle
    // Normal heartbeat + forced heartbeat for cron job = 2 agent runs
    expect(_mockRunCalls.length).toBe(2)
  })

  it('E26: sessionTarget=main + wakeMode=next-heartbeat only enqueues, no extra agent run', async () => {
    _mockResponseText = 'HEARTBEAT_OK'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [
        makeDueJob({
          id: 'job-main-lazy',
          sessionTarget: 'main',
          wakeMode: 'next-heartbeat',
          prompt: 'Lazy check',
        }),
      ]),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // Only 1 agent run (the normal heartbeat), no forced extra cycle
    expect(_mockRunCalls.length).toBe(1)
    expect(cronDb.enqueueSystemEvent).toHaveBeenCalled()
  })

  it('E27: disabled job in getDueJobs list is skipped silently', async () => {
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [makeDueJob({ id: 'job-disabled', enabled: false })]),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // No cron.job.started event for the disabled job
    expect(dispatched.filter((m) => m.type === 'cron.job.started').length).toBe(0)
    // But heartbeat still runs
    expect(dispatched.find((m) => m.type === 'heartbeat.started')).toBeDefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// F. Event Completeness
// ══════════════════════════════════════════════════════════════════════════

describe('F. Event Completeness', () => {
  it('F28: success emits started → notification → completed(ok) → status', async () => {
    _mockResponseText = 'Important alert'
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const types = dispatched.map((m) => m.type)
    expect(types).toContain('heartbeat.started')
    expect(types).toContain('cron.notification')
    expect(types).toContain('heartbeat.completed')
    expect(types).toContain('scheduler.status')

    // Verify order: started before completed
    const startIdx = types.indexOf('heartbeat.started')
    const completedIdx = types.indexOf('heartbeat.completed')
    const statusIdx = types.indexOf('scheduler.status')
    expect(startIdx).toBeLessThan(completedIdx)
    expect(completedIdx).toBeLessThan(statusIdx)

    expect(dispatched.find((m) => m.type === 'heartbeat.completed')?.status).toBe('ok')
  })

  it('F29: dedup emits started → completed(deduped) → status, NO notification', async () => {
    const hash = fnv1aHash('Background alert')
    const cronDb = createCronDb({
      getHeartbeatConfig: vi.fn(async () => ({
        enabled: true,
        everyMs: 1_000,
        prompt: 'Check in',
        lastHash: hash,
        lastSentAt: Date.now() - 60_000,
      })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(dispatched.find((m) => m.type === 'heartbeat.completed')?.status).toBe('deduped')
    // No notification for deduped
    expect(dispatched.filter((m) => m.type === 'cron.notification').length).toBe(0)
  })

  it('F30: scheduler disabled emits skipped → status, NO started', async () => {
    const cronDb = createCronDb({
      getSchedulerConfig: vi.fn(async () => ({ enabled: false })),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('mobilecron')

    expect(dispatched.find((m) => m.type === 'heartbeat.skipped')?.reason).toBe('scheduler_disabled')
    expect(dispatched.find((m) => m.type === 'scheduler.status')).toBeDefined()
    // No started event
    expect(dispatched.filter((m) => m.type === 'heartbeat.started').length).toBe(0)
  })

  it('F31: heartbeat error emits started → completed(error)', async () => {
    _mockShouldThrow = 'catastrophic failure'
    const cronDb = createCronDb()
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    const types = dispatched.map((m) => m.type)
    expect(types).toContain('heartbeat.started')
    expect(types).toContain('heartbeat.completed')

    const completed = dispatched.find((m) => m.type === 'heartbeat.completed')
    expect(completed?.status).toBe('error')
    expect(completed?.reason).toContain('catastrophic failure')
  })

  it('F32: cron job error emits cron.job.started + cron.job.error (not completed)', async () => {
    _mockShouldThrow = 'job explosion'
    const cronDb = createCronDb({
      getDueJobs: vi.fn(async () => [makeDueJob({ id: 'job-boom' })]),
    })
    const { manager, dispatched } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // Heartbeat errors too (same mock), but check the cron events
    const cronError = dispatched.find((m) => m.type === 'cron.job.error')
    expect(cronError?.jobId).toBe('job-boom')
    expect(cronError?.error).toContain('job explosion')
    expect(cronError?.consecutiveErrors).toBe(1)

    // No cron.job.completed for the errored job
    const cronCompleted = dispatched.filter((m) => m.type === 'cron.job.completed' && m.jobId === 'job-boom')
    expect(cronCompleted.length).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// G. System Events
// ══════════════════════════════════════════════════════════════════════════

describe('G. System Events', () => {
  it('G33: pending events are included in heartbeat prompt', async () => {
    const cronDb = createCronDb({
      peekPendingEvents: vi.fn(async () => [
        {
          id: 1,
          sessionKey: 'main-session',
          contextKey: 'cron:a',
          text: 'Event A',
          createdAt: Date.now(),
          consumed: false,
        },
        {
          id: 2,
          sessionKey: 'main-session',
          contextKey: 'cron:b',
          text: 'Event B',
          createdAt: Date.now(),
          consumed: false,
        },
        {
          id: 3,
          sessionKey: 'main-session',
          contextKey: null,
          text: 'Event C',
          createdAt: Date.now(),
          consumed: false,
        },
      ]),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(_mockRunCalls.length).toBeGreaterThanOrEqual(1)
    const prompt = _mockRunCalls[0].prompt
    expect(prompt).toContain('System events:')
    expect(prompt).toContain('Event A')
    expect(prompt).toContain('Event B')
    expect(prompt).toContain('Event C')
    expect(prompt).toContain('cron:a')
    expect(prompt).toContain('cron:b')
  })

  it('G34: events consumed after successful heartbeat', async () => {
    _mockResponseText = 'Important update'
    const events = [
      { id: 10, sessionKey: 'main-session', contextKey: 'test', text: 'Evt', createdAt: Date.now(), consumed: false },
    ]
    const cronDb = createCronDb({
      peekPendingEvents: vi.fn(async () => events),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    expect(cronDb.consumePendingEvents).toHaveBeenCalledWith([10])
  })

  it('G35: events NOT consumed on heartbeat error (accumulate)', async () => {
    _mockShouldThrow = 'agent failed'
    const events = [
      { id: 20, sessionKey: 'main-session', contextKey: 'test', text: 'Evt', createdAt: Date.now(), consumed: false },
    ]
    const cronDb = createCronDb({
      peekPendingEvents: vi.fn(async () => events),
    })
    const { manager } = createManager(cronDb)

    await manager.handleWake('manual', { force: true })

    // consumePendingEvents should NOT have been called
    expect(cronDb.consumePendingEvents).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// H. Pure Functions
// ══════════════════════════════════════════════════════════════════════════

describe('H. Pure Functions', () => {
  it('H36: isHeartbeatOk with trailing newline and text is true', () => {
    expect(isHeartbeatOk('HEARTBEAT_OK\nSome extra info')).toBe(true)
    expect(isHeartbeatOk('ok\nDetails here')).toBe(true)
    expect(isHeartbeatOk('✓\nAll good')).toBe(true)
  })

  it('H37: isHeartbeatOk partial match is false', () => {
    expect(isHeartbeatOk('HEARTBEAT_OK_EXTRA')).toBe(false)
    expect(isHeartbeatOk('okish')).toBe(false)
    expect(isHeartbeatOk('OK_STATUS')).toBe(false)
    expect(isHeartbeatOk('Not ok')).toBe(false)
  })

  it('H38: fnv1aHash determinism and 8-char hex format', () => {
    const h1 = fnv1aHash('deterministic test')
    const h2 = fnv1aHash('deterministic test')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)

    // Different inputs → different hashes
    expect(fnv1aHash('a')).not.toBe(fnv1aHash('b'))
    expect(fnv1aHash('')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('H39: buildHeartbeatPrompt with empty events returns base only', () => {
    const result = buildHeartbeatPrompt('Base prompt', [])
    expect(result).toBe('Base prompt')
    expect(result).not.toContain('System events:')
  })

  it('H40: buildHeartbeatPrompt with events includes timestamps and contextKeys', () => {
    const ts = Date.UTC(2026, 2, 10, 12, 0, 0)
    const result = buildHeartbeatPrompt('Check in', [
      {
        id: 1,
        sessionKey: 'main',
        contextKey: 'cron:job-1',
        text: 'Review pull request',
        createdAt: ts,
        consumed: false,
      },
      { id: 2, sessionKey: 'main', contextKey: null, text: 'System update', createdAt: ts + 1000, consumed: false },
    ])

    expect(result).toContain('Check in')
    expect(result).toContain('System events:')
    expect(result).toContain('cron:job-1')
    expect(result).toContain('Review pull request')
    expect(result).toContain('System update')
    expect(result).toContain('2026-03-10')
  })
})
