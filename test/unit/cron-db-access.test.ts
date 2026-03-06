import { afterEach, describe, expect, it, vi } from 'vitest'

const sqliteState = vi.hoisted(() => {
  const db = {
    open: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ changes: { changes: 0 } })),
    run: vi.fn(async () => ({ changes: 1, lastId: 0 })),
    query: vi.fn(async () => ({ values: [] })),
  }

  return {
    db,
    connection: {
      checkConnectionsConsistency: vi.fn(async () => {}),
      isConnection: vi.fn(async () => ({ result: true })),
      retrieveConnection: vi.fn(async () => db),
      createConnection: vi.fn(async () => db),
      initWebStore: vi.fn(async () => {}),
    },
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
}))

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn(() => sqliteState.connection),
}))

import { CronDbAccess } from '../../src/agent/cron-db-access'

describe('CronDbAccess', () => {
  afterEach(() => {
    vi.clearAllMocks()
    sqliteState.db.query.mockResolvedValue({ values: [] })
  })

  it('maps due cron job rows from SQLite', async () => {
    sqliteState.db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM cron_jobs')) {
        return {
          values: [
            {
              id: 'job-1',
              name: 'Morning check',
              enabled: 1,
              session_target: 'main',
              wake_mode: 'now',
              schedule_kind: 'every',
              schedule_every_ms: 60_000,
              schedule_at_ms: null,
              skill_id: 'skill-1',
              prompt: 'Check status',
              delivery_mode: 'notification',
              active_hours_start: '08:00',
              active_hours_end: '18:00',
              active_hours_tz: 'UTC',
              last_run_at: 100,
              next_run_at: 200,
              last_run_status: 'ok',
              last_error: null,
              last_duration_ms: 50,
              last_response_hash: 'abc123',
              last_response_sent_at: 150,
              consecutive_errors: 0,
              created_at: 10,
              updated_at: 20,
            },
          ],
        }
      }
      return { values: [] }
    })

    const access = new CronDbAccess()
    const jobs = await access.getDueJobs(500)

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        id: 'job-1',
        enabled: true,
        sessionTarget: 'main',
        wakeMode: 'now',
        lastResponseHash: 'abc123',
        lastResponseSentAt: 150,
      }),
    )
    expect(jobs[0].activeHours).toEqual({ start: '08:00', end: '18:00', tz: 'UTC' })
  })

  it('writes heartbeat config patches with the expected columns', async () => {
    sqliteState.db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM heartbeat_config')) {
        return {
          values: [
            {
              enabled: 1,
              every_ms: 1_000,
              prompt: null,
              skill_id: null,
              next_run_at: null,
              last_heartbeat_hash: null,
              last_heartbeat_sent_at: null,
              updated_at: 1,
            },
          ],
        }
      }
      return { values: [] }
    })

    const access = new CronDbAccess()
    await access.setHeartbeatConfig({
      enabled: false,
      lastHash: 'deadbeef',
      lastSentAt: 123,
    })

    const updateCall = sqliteState.db.run.mock.calls.find(([sql]: [string]) =>
      sql.includes('UPDATE heartbeat_config SET'),
    )
    expect(updateCall).toBeDefined()
    expect(updateCall?.[0]).toContain('last_heartbeat_hash = ?')
    expect(updateCall?.[0]).toContain('last_heartbeat_sent_at = ?')
    expect(updateCall?.[1]).toEqual(expect.arrayContaining([0, 'deadbeef', 123]))
  })
})
