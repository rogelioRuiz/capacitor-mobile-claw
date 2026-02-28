import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import type { CronJobRecord, CronSkillRecord, HeartbeatConfig, SchedulerConfig } from '../definitions'

const DB_NAME = 'mobile-claw'
const DB_VERSION = 2

export interface SchedulerStoreConfig extends SchedulerConfig {
  updatedAt?: number
}

export interface HeartbeatStoreConfig extends HeartbeatConfig {
  updatedAt?: number
}

export interface CronSkillStoreRecord extends CronSkillRecord {}

export interface CronJobStoreRecord extends CronJobRecord {
  lastResponseHash?: string
  lastResponseSentAt?: number
}

export interface PendingSystemEvent {
  id: number
  sessionKey: string
  contextKey?: string
  text: string
  createdAt: number
  consumed: boolean
}

export interface CronRunInsert {
  jobId: string
  startedAt: number
  endedAt?: number | null
  status?: string | null
  durationMs?: number | null
  error?: string | null
  responseText?: string | null
  wasHeartbeatOk?: boolean
  wasDeduped?: boolean
  delivered?: boolean
  wakeSource?: string | null
}

export class CronDbAccess {
  private sqlite: SQLiteConnection | null = null
  private db: any = null
  private initPromise: Promise<void> | null = null

  async ensureReady(): Promise<void> {
    if (this.db) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = this._init()
    await this.initPromise
  }

  async getSchedulerConfig(): Promise<SchedulerStoreConfig> {
    await this.ensureReady()
    await this._run(
      `INSERT OR IGNORE INTO scheduler_config
       (id, enabled, scheduling_mode, run_on_charging, updated_at)
       VALUES (1, 1, 'balanced', 1, ?)`,
      [Date.now()],
    )
    const row = await this._queryOne('SELECT * FROM scheduler_config WHERE id = 1')
    return {
      enabled: _toBool(row?.enabled),
      schedulingMode: row?.scheduling_mode || 'balanced',
      runOnCharging: _toBool(row?.run_on_charging),
      globalActiveHours: _mapActiveHours(
        row?.global_active_hours_start,
        row?.global_active_hours_end,
        row?.global_active_hours_tz,
      ) as any,
      updatedAt: row?.updated_at ?? undefined,
    }
  }

  async getHeartbeatConfig(): Promise<HeartbeatStoreConfig> {
    await this.ensureReady()
    await this._run(
      `INSERT OR IGNORE INTO heartbeat_config
       (id, enabled, every_ms, updated_at)
       VALUES (1, 0, 1800000, ?)`,
      [Date.now()],
    )
    const row = await this._queryOne('SELECT * FROM heartbeat_config WHERE id = 1')
    return {
      enabled: _toBool(row?.enabled),
      everyMs: row?.every_ms ?? 1_800_000,
      prompt: row?.prompt || undefined,
      skillId: row?.skill_id || undefined,
      activeHours: _mapActiveHours(row?.active_hours_start, row?.active_hours_end, row?.active_hours_tz) as any,
      nextRunAt: row?.next_run_at ?? undefined,
      lastHash: row?.last_heartbeat_hash || undefined,
      lastSentAt: row?.last_heartbeat_sent_at ?? undefined,
      updatedAt: row?.updated_at ?? undefined,
    }
  }

  async setHeartbeatConfig(patch: Record<string, unknown> = {}): Promise<HeartbeatStoreConfig> {
    await this.ensureReady()
    await this.getHeartbeatConfig()

    const sets: string[] = []
    const params: unknown[] = []

    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(_toIntBool(Boolean(patch.enabled)))
    }
    if (patch.everyMs !== undefined || patch.every_ms !== undefined) {
      sets.push('every_ms = ?')
      params.push(Number(patch.everyMs ?? patch.every_ms) || 1_800_000)
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?')
      params.push((patch.prompt as string) || null)
    }
    if (patch.skillId !== undefined || patch.skill_id !== undefined) {
      sets.push('skill_id = ?')
      params.push((patch.skillId ?? patch.skill_id) || null)
    }

    const activeHours = (patch.activeHours || patch.active_hours) as
      | { start?: string; end?: string; tz?: string; timezone?: string }
      | undefined
    if (activeHours) {
      sets.push('active_hours_start = ?')
      params.push(activeHours.start || null)
      sets.push('active_hours_end = ?')
      params.push(activeHours.end || null)
      sets.push('active_hours_tz = ?')
      params.push(activeHours.tz || activeHours.timezone || null)
    } else {
      if (patch.active_hours_start !== undefined) {
        sets.push('active_hours_start = ?')
        params.push((patch.active_hours_start as string) || null)
      }
      if (patch.active_hours_end !== undefined) {
        sets.push('active_hours_end = ?')
        params.push((patch.active_hours_end as string) || null)
      }
      if (patch.active_hours_tz !== undefined) {
        sets.push('active_hours_tz = ?')
        params.push((patch.active_hours_tz as string) || null)
      }
    }

    if (patch.nextRunAt !== undefined || patch.next_run_at !== undefined) {
      sets.push('next_run_at = ?')
      params.push(patch.nextRunAt ?? patch.next_run_at ?? null)
    }
    if (patch.lastHash !== undefined || patch.last_heartbeat_hash !== undefined) {
      sets.push('last_heartbeat_hash = ?')
      params.push((patch.lastHash ?? patch.last_heartbeat_hash) || null)
    }
    if (patch.lastSentAt !== undefined || patch.last_heartbeat_sent_at !== undefined) {
      sets.push('last_heartbeat_sent_at = ?')
      params.push(patch.lastSentAt ?? patch.last_heartbeat_sent_at ?? null)
    }

    sets.push('updated_at = ?')
    params.push(Date.now())
    params.push(1)

    await this._run(`UPDATE heartbeat_config SET ${sets.join(', ')} WHERE id = ?`, params)
    return this.getHeartbeatConfig()
  }

  async listCronSkills(): Promise<CronSkillStoreRecord[]> {
    await this.ensureReady()
    const result = await this.db.query('SELECT * FROM cron_skills ORDER BY updated_at DESC')
    return (result.values || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      allowedTools: _parseJsonArray(row.allowed_tools),
      systemPrompt: row.system_prompt || undefined,
      model: row.model || undefined,
      maxTurns: row.max_turns ?? 3,
      timeoutMs: row.timeout_ms ?? 60_000,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async listCronJobs(): Promise<CronJobStoreRecord[]> {
    await this.ensureReady()
    const result = await this.db.query('SELECT * FROM cron_jobs ORDER BY updated_at DESC')
    return (result.values || []).map((row: any) => _toCronJobRecord(row))
  }

  async getDueJobs(nowMs = Date.now()): Promise<CronJobStoreRecord[]> {
    await this.ensureReady()
    const result = await this.db.query(
      `SELECT * FROM cron_jobs
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
      [nowMs],
    )
    return (result.values || []).map((row: any) => _toCronJobRecord(row))
  }

  async updateCronJob(id: string, patch: Record<string, unknown> = {}): Promise<void> {
    await this.ensureReady()

    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(_toIntBool(Boolean(patch.enabled)))
    }
    if (patch.sessionTarget !== undefined || patch.session_target !== undefined) {
      sets.push('session_target = ?')
      params.push((patch.sessionTarget ?? patch.session_target) || 'isolated')
    }
    if (patch.wakeMode !== undefined || patch.wake_mode !== undefined) {
      sets.push('wake_mode = ?')
      params.push((patch.wakeMode ?? patch.wake_mode) || 'next-heartbeat')
    }

    const schedule = patch.schedule as Record<string, unknown> | undefined
    if (schedule) {
      if (schedule.kind !== undefined) {
        sets.push('schedule_kind = ?')
        params.push(schedule.kind)
      }
      if (schedule.everyMs !== undefined || schedule.every_ms !== undefined) {
        sets.push('schedule_every_ms = ?')
        params.push(Number(schedule.everyMs ?? schedule.every_ms) || null)
      }
      if (schedule.anchorMs !== undefined || schedule.anchor_ms !== undefined) {
        sets.push('schedule_anchor_ms = ?')
        params.push(Number(schedule.anchorMs ?? schedule.anchor_ms) || null)
      }
      if (schedule.atMs !== undefined || schedule.at_ms !== undefined) {
        sets.push('schedule_at_ms = ?')
        params.push(Number(schedule.atMs ?? schedule.at_ms) || null)
      }
    } else {
      if (patch.scheduleKind !== undefined || patch.schedule_kind !== undefined) {
        sets.push('schedule_kind = ?')
        params.push(patch.scheduleKind ?? patch.schedule_kind)
      }
      if (patch.scheduleEveryMs !== undefined || patch.schedule_every_ms !== undefined) {
        sets.push('schedule_every_ms = ?')
        params.push(Number(patch.scheduleEveryMs ?? patch.schedule_every_ms) || null)
      }
      if (patch.scheduleAnchorMs !== undefined || patch.schedule_anchor_ms !== undefined) {
        sets.push('schedule_anchor_ms = ?')
        params.push(Number(patch.scheduleAnchorMs ?? patch.schedule_anchor_ms) || null)
      }
      if (patch.scheduleAtMs !== undefined || patch.schedule_at_ms !== undefined) {
        sets.push('schedule_at_ms = ?')
        params.push(Number(patch.scheduleAtMs ?? patch.schedule_at_ms) || null)
      }
    }

    if (patch.skillId !== undefined || patch.skill_id !== undefined) {
      sets.push('skill_id = ?')
      params.push((patch.skillId ?? patch.skill_id) || null)
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?')
      params.push((patch.prompt as string) || '')
    }
    if (patch.deliveryMode !== undefined || patch.delivery_mode !== undefined) {
      sets.push('delivery_mode = ?')
      params.push((patch.deliveryMode ?? patch.delivery_mode) || 'notification')
    }
    if (patch.deliveryWebhookUrl !== undefined || patch.delivery_webhook_url !== undefined) {
      sets.push('delivery_webhook_url = ?')
      params.push((patch.deliveryWebhookUrl ?? patch.delivery_webhook_url) || null)
    }
    if (patch.deliveryNotificationTitle !== undefined || patch.delivery_notification_title !== undefined) {
      sets.push('delivery_notification_title = ?')
      params.push((patch.deliveryNotificationTitle ?? patch.delivery_notification_title) || null)
    }

    const activeHours = (patch.activeHours || patch.active_hours) as
      | { start?: string; end?: string; tz?: string; timezone?: string }
      | undefined
    if (activeHours) {
      sets.push('active_hours_start = ?')
      params.push(activeHours.start || null)
      sets.push('active_hours_end = ?')
      params.push(activeHours.end || null)
      sets.push('active_hours_tz = ?')
      params.push(activeHours.tz || activeHours.timezone || null)
    } else {
      if (patch.active_hours_start !== undefined) {
        sets.push('active_hours_start = ?')
        params.push((patch.active_hours_start as string) || null)
      }
      if (patch.active_hours_end !== undefined) {
        sets.push('active_hours_end = ?')
        params.push((patch.active_hours_end as string) || null)
      }
      if (patch.active_hours_tz !== undefined) {
        sets.push('active_hours_tz = ?')
        params.push((patch.active_hours_tz as string) || null)
      }
    }

    if (patch.lastRunAt !== undefined || patch.last_run_at !== undefined) {
      sets.push('last_run_at = ?')
      params.push(patch.lastRunAt ?? patch.last_run_at ?? null)
    }
    if (patch.nextRunAt !== undefined || patch.next_run_at !== undefined) {
      sets.push('next_run_at = ?')
      params.push(patch.nextRunAt ?? patch.next_run_at ?? null)
    }
    if (patch.lastRunStatus !== undefined || patch.last_run_status !== undefined) {
      sets.push('last_run_status = ?')
      params.push((patch.lastRunStatus ?? patch.last_run_status) || null)
    }
    if (patch.lastError !== undefined || patch.last_error !== undefined) {
      sets.push('last_error = ?')
      params.push((patch.lastError ?? patch.last_error) || null)
    }
    if (patch.lastDurationMs !== undefined || patch.last_duration_ms !== undefined) {
      sets.push('last_duration_ms = ?')
      params.push(patch.lastDurationMs ?? patch.last_duration_ms ?? null)
    }
    if (patch.lastResponseHash !== undefined || patch.last_response_hash !== undefined) {
      sets.push('last_response_hash = ?')
      params.push((patch.lastResponseHash ?? patch.last_response_hash) || null)
    }
    if (patch.lastResponseSentAt !== undefined || patch.last_response_sent_at !== undefined) {
      sets.push('last_response_sent_at = ?')
      params.push(patch.lastResponseSentAt ?? patch.last_response_sent_at ?? null)
    }
    if (patch.consecutiveErrors !== undefined || patch.consecutive_errors !== undefined) {
      sets.push('consecutive_errors = ?')
      params.push(Number(patch.consecutiveErrors ?? patch.consecutive_errors) || 0)
    }

    sets.push('updated_at = ?')
    params.push(Date.now())
    params.push(id)

    await this._run(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  async insertCronRun(runData: CronRunInsert): Promise<number | null> {
    await this.ensureReady()
    await this._run(
      `INSERT INTO cron_runs
       (job_id, started_at, ended_at, status, duration_ms, error, response_text, was_heartbeat_ok, was_deduped, delivered, wake_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runData.jobId,
        runData.startedAt,
        runData.endedAt ?? null,
        runData.status ?? null,
        runData.durationMs ?? null,
        runData.error ?? null,
        runData.responseText ?? null,
        _toIntBool(Boolean(runData.wasHeartbeatOk)),
        _toIntBool(Boolean(runData.wasDeduped)),
        _toIntBool(Boolean(runData.delivered)),
        runData.wakeSource ?? null,
      ],
    )
    const row = await this._queryOne('SELECT last_insert_rowid() as id')
    return row?.id ?? null
  }

  async peekPendingEvents(sessionKey: string): Promise<PendingSystemEvent[]> {
    await this.ensureReady()
    const result = await this.db.query(
      `SELECT id, session_key, context_key, text, created_at, consumed
       FROM system_events
       WHERE session_key = ? AND consumed = 0
       ORDER BY created_at ASC, id ASC`,
      [sessionKey],
    )
    return (result.values || []).map((row: any) => ({
      id: row.id,
      sessionKey: row.session_key,
      contextKey: row.context_key || undefined,
      text: row.text,
      createdAt: row.created_at,
      consumed: _toBool(row.consumed),
    }))
  }

  async consumePendingEvents(ids: number[]): Promise<void> {
    await this.ensureReady()
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    await this._run(`UPDATE system_events SET consumed = 1 WHERE id IN (${placeholders})`, ids)
  }

  async enqueueSystemEvent(sessionKey: string, contextKey: string | null, text: string): Promise<void> {
    await this.ensureReady()
    await this._run(
      `INSERT INTO system_events
       (session_key, context_key, text, created_at, consumed)
       VALUES (?, ?, ?, ?, 0)`,
      [sessionKey, contextKey || null, text, Date.now()],
    )
  }

  async getMaxMessageSequence(sessionKey: string): Promise<number> {
    await this.ensureReady()
    const row = await this._queryOne('SELECT MAX(sequence) as max_seq FROM messages WHERE session_key = ?', [
      sessionKey,
    ])
    return Number.isFinite(row?.max_seq) ? row.max_seq : -1
  }

  async deleteMessagesAfter(sessionKey: string, sequence: number): Promise<void> {
    await this.ensureReady()
    await this._run('DELETE FROM messages WHERE session_key = ? AND sequence > ?', [sessionKey, sequence])
  }

  private async _init(): Promise<void> {
    this.sqlite = new SQLiteConnection(CapacitorSQLite)

    if (Capacitor.getPlatform() === 'web') {
      if (!document.querySelector('jeep-sqlite')) {
        const el = document.createElement('jeep-sqlite')
        document.body.appendChild(el)
      }
      await customElements.whenDefined('jeep-sqlite')
      await this.sqlite.initWebStore()
    }

    await this.sqlite.checkConnectionsConsistency()

    const isConn = await this.sqlite.isConnection(DB_NAME, false)
    if (isConn.result) {
      this.db = await this.sqlite.retrieveConnection(DB_NAME, false)
    } else {
      this.db = await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false)
    }

    await this.db.open()
  }

  private async _run(sql: string, params: unknown[] = []): Promise<void> {
    await this.ensureReady()
    await this.db.run(sql, params, true)
  }

  private async _queryOne(sql: string, params: unknown[] = []): Promise<any | null> {
    await this.ensureReady()
    const result = await this.db.query(sql, params)
    return result.values?.[0] ?? null
  }
}

function _toBool(value: unknown): boolean {
  return Number(value) === 1
}

function _toIntBool(value: boolean): number {
  return value ? 1 : 0
}

function _parseJsonArray(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function _mapActiveHours(start?: string | null, end?: string | null, tz?: string | null): any {
  if (!start && !end && !tz) return undefined
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(tz ? { tz } : {}),
  }
}

function _toCronJobRecord(row: any): CronJobStoreRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: _toBool(row.enabled),
    sessionTarget: row.session_target || 'isolated',
    wakeMode: row.wake_mode || 'next-heartbeat',
    schedule: {
      kind: row.schedule_kind,
      everyMs: row.schedule_every_ms ?? undefined,
      atMs: row.schedule_at_ms ?? undefined,
    },
    skillId: row.skill_id,
    prompt: row.prompt,
    deliveryMode: row.delivery_mode || 'notification',
    deliveryWebhookUrl: row.delivery_webhook_url || undefined,
    deliveryNotificationTitle: row.delivery_notification_title || undefined,
    activeHours: _mapActiveHours(row.active_hours_start, row.active_hours_end, row.active_hours_tz) as any,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunStatus: row.last_run_status || undefined,
    lastError: row.last_error || undefined,
    lastDurationMs: row.last_duration_ms ?? undefined,
    lastResponseHash: row.last_response_hash || undefined,
    lastResponseSentAt: row.last_response_sent_at ?? undefined,
    consecutiveErrors: row.consecutive_errors ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
