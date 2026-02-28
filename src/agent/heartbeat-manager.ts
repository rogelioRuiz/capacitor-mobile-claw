import { AgentRunner } from './agent-runner'
import type { CronDbAccess, CronJobStoreRecord, CronSkillStoreRecord, PendingSystemEvent } from './cron-db-access'
import { SessionStore } from './session-store'
import type { ToolProxy } from './tool-proxy'

type AgentTool<
  TParameters extends import('@sinclair/typebox').TSchema = import('@sinclair/typebox').TSchema,
  TDetails = any,
> = import('@mariozechner/pi-agent-core').AgentTool<TParameters, TDetails>

const DEFAULT_HEARTBEAT_PROMPT =
  'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'
const HEARTBEAT_OK_TOKENS = ['HEARTBEAT_OK', 'heartbeat_ok', 'ok', 'OK', '✓', '👍']
const ERROR_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000]
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const WORKER_BRIDGE_TIMEOUT_MS = 10_000

export interface HeartbeatManagerConfig {
  dispatch: (msg: Record<string, unknown>) => void
  toolProxy: ToolProxy
  cronDb: CronDbAccess
  getAuth: (provider: string, agentId: string) => Promise<{ apiKey: string | null }>
  getSystemPrompt: (agentId: string) => Promise<{ systemPrompt: string }>
  isUserAgentRunning: () => boolean
  getCurrentSessionKey: () => string | null
  extraTools?: AgentTool<any>[]
}

interface HeartbeatWakeOptions {
  force?: boolean
  forceJobId?: string
  forceSessionKey?: string
}

interface HeartbeatCycleResult {
  status: 'ok' | 'error' | 'skipped' | 'suppressed' | 'deduped'
  reason?: string
  responsePreview?: string
}

interface AgentRunResult {
  text: string
  sessionKey: string
  messages: any[]
  model: string
}

export class HeartbeatManager {
  private config: HeartbeatManagerConfig
  private wakeInFlight = false
  private heartbeatConsecutiveErrors = 0
  private sessionStore = new SessionStore()

  constructor(config: HeartbeatManagerConfig) {
    this.config = config
  }

  async handleWake(source: string, opts: HeartbeatWakeOptions = {}): Promise<void> {
    if (this.wakeInFlight) {
      this._emit('heartbeat.skipped', { reason: 'busy' })
      return
    }

    this.wakeInFlight = true
    const startedAt = Date.now()

    try {
      const scheduler = await this.config.cronDb.getSchedulerConfig()
      const isManual = source === 'manual' || opts.force === true

      if (!isManual && !scheduler.enabled) {
        this._emit('heartbeat.skipped', { reason: 'scheduler_disabled' })
        await this._emitSchedulerStatus()
        return
      }

      if (!isManual && this.config.isUserAgentRunning()) {
        this._emit('heartbeat.skipped', { reason: 'user_active' })
        await this._emitSchedulerStatus()
        return
      }

      this._emit('heartbeat.started', { source })

      const now = Date.now()
      const heartbeatResult = await this._runHeartbeatCycle({
        source,
        now,
        force: isManual,
        forceSessionKey: opts.forceSessionKey,
      })

      await this._runDueCronJobs({
        source,
        now,
        forceJobId: opts.forceJobId,
      })

      const durationMs = Date.now() - startedAt
      if (heartbeatResult.status === 'skipped') {
        this._emit('heartbeat.skipped', { reason: heartbeatResult.reason || 'not_due' })
      } else {
        this._emit('heartbeat.completed', {
          status: heartbeatResult.status,
          reason: heartbeatResult.reason,
          durationMs,
          ...(heartbeatResult.responsePreview ? { responsePreview: heartbeatResult.responsePreview } : {}),
        })
      }

      await this._emitSchedulerStatus()
    } catch (err: any) {
      this._emit('heartbeat.completed', {
        status: 'error',
        reason: err?.message || 'heartbeat_failed',
        durationMs: Date.now() - startedAt,
      })
    } finally {
      this.wakeInFlight = false
    }
  }

  private async _runHeartbeatCycle(params: {
    source: string
    now: number
    force?: boolean
    forceSessionKey?: string
  }): Promise<HeartbeatCycleResult> {
    const config = await this.config.cronDb.getHeartbeatConfig()
    const startedAt = params.now
    const everyMs = Number(config.everyMs) || 1_800_000

    if (!params.force && !config.enabled) {
      return { status: 'skipped', reason: 'heartbeat_disabled' }
    }

    if (!params.force && config.nextRunAt && startedAt < config.nextRunAt) {
      return { status: 'skipped', reason: 'not_due' }
    }

    if (!isWithinActiveHours(config.activeHours?.start, config.activeHours?.end, config.activeHours?.tz, startedAt)) {
      await this.config.cronDb.setHeartbeatConfig({
        nextRunAt: startedAt + Math.max(15_000, everyMs),
      })
      return { status: 'skipped', reason: 'outside_active_hours' }
    }

    const heartbeatSkill = await this._resolveSkill(config.skillId)
    const eventSessionKey = params.forceSessionKey || this.config.getCurrentSessionKey() || 'main'
    const pendingEvents = await this.config.cronDb.peekPendingEvents(eventSessionKey)
    const prompt = buildHeartbeatPrompt(config.prompt || DEFAULT_HEARTBEAT_PROMPT, pendingEvents)

    try {
      const result = await this._runAgentTurn({
        prompt,
        skill: heartbeatSkill,
        sessionKey: `heartbeat/${startedAt}`,
      })
      const trimmed = result.text.trim()
      const hash = fnv1aHash(trimmed)
      const isOk = isHeartbeatOk(trimmed)
      const isDuplicate =
        !!trimmed &&
        !!config.lastHash &&
        config.lastHash === hash &&
        !!config.lastSentAt &&
        startedAt - config.lastSentAt < DEDUP_WINDOW_MS

      if (!trimmed || isOk || isDuplicate) {
        await this._consumePendingEvents(pendingEvents)
        await this.config.cronDb.setHeartbeatConfig({
          nextRunAt: startedAt + everyMs,
        })
        this.heartbeatConsecutiveErrors = 0

        if (isDuplicate) return { status: 'deduped', reason: 'duplicate' }
        if (isOk) return { status: 'suppressed', reason: 'heartbeat_ok' }
        return { status: 'suppressed', reason: 'empty' }
      }

      await this._persistSession(result)
      await this._consumePendingEvents(pendingEvents)
      await this.config.cronDb.setHeartbeatConfig({
        nextRunAt: startedAt + everyMs,
        lastHash: hash,
        lastSentAt: startedAt,
      })

      this.heartbeatConsecutiveErrors = 0
      this._emit('cron.notification', {
        title: 'Sentinel heartbeat',
        body: trimmed,
        source: 'heartbeat',
      })

      return {
        status: 'ok',
        responsePreview: trimmed.slice(0, 240),
      }
    } catch (err: any) {
      this.heartbeatConsecutiveErrors += 1
      const normalNext = startedAt + everyMs
      const backoffNext = startedAt + errorBackoffMs(this.heartbeatConsecutiveErrors)
      await this.config.cronDb.setHeartbeatConfig({
        nextRunAt: Math.max(normalNext, backoffNext),
      })
      return {
        status: 'error',
        reason: err?.message || 'heartbeat_error',
      }
    }
  }

  private async _runDueCronJobs(params: { source: string; now: number; forceJobId?: string }): Promise<void> {
    const skills = await this.config.cronDb.listCronSkills()
    const skillById = new Map(skills.map((skill) => [skill.id, skill]))
    const allJobs = await this.config.cronDb.listCronJobs()
    const dueJobs = params.forceJobId
      ? allJobs.filter((job) => job.id === params.forceJobId)
      : await this.config.cronDb.getDueJobs(params.now)

    for (const job of dueJobs) {
      const startedAt = Date.now()
      const skill = skillById.get(job.skillId) || null

      if (!job.enabled) continue

      if (!isWithinActiveHours(job.activeHours?.start, job.activeHours?.end, job.activeHours?.tz, startedAt)) {
        await this.config.cronDb.updateCronJob(job.id, {
          lastRunAt: startedAt,
          nextRunAt: computeNextRunAt(job, startedAt),
          lastRunStatus: 'skipped',
        })
        await this.config.cronDb.insertCronRun({
          jobId: job.id,
          startedAt,
          endedAt: Date.now(),
          status: 'skipped',
          wakeSource: params.source,
        })
        continue
      }

      this._emit('cron.job.started', { jobId: job.id, jobName: job.name })

      try {
        if (job.sessionTarget === 'main') {
          const sessionKey = this.config.getCurrentSessionKey() || 'main'
          await this.config.cronDb.enqueueSystemEvent(sessionKey, `cron:${job.id}:${startedAt}`, job.prompt)

          if (job.wakeMode === 'now' || params.forceJobId === job.id) {
            await this._runHeartbeatCycle({
              source: `cron:${job.id}`,
              now: Date.now(),
              force: true,
              forceSessionKey: sessionKey,
            })
          }

          const runEndedAt = Date.now()
          await this.config.cronDb.updateCronJob(job.id, {
            lastRunAt: startedAt,
            nextRunAt: computeNextRunAt(job, startedAt),
            lastRunStatus: 'ok',
            lastError: null,
            lastDurationMs: runEndedAt - startedAt,
            consecutiveErrors: 0,
          })
          await this.config.cronDb.insertCronRun({
            jobId: job.id,
            startedAt,
            endedAt: runEndedAt,
            status: 'ok',
            responseText: 'Enqueued to main session heartbeat.',
            delivered: false,
            wakeSource: params.source,
          })
          this._emit('cron.job.completed', {
            jobId: job.id,
            status: 'ok',
            durationMs: runEndedAt - startedAt,
            responsePreview: 'Queued for heartbeat',
          })
          continue
        }

        const result = await this._runAgentTurn({
          prompt: job.prompt,
          skill,
          sessionKey: `cron/${job.id}/${startedAt}`,
        })
        const trimmed = result.text.trim()
        const hash = fnv1aHash(trimmed)
        const heartbeatOk = isHeartbeatOk(trimmed)
        const isDeduped =
          !!trimmed &&
          !!job.lastResponseHash &&
          job.lastResponseHash === hash &&
          !!job.lastResponseSentAt &&
          startedAt - job.lastResponseSentAt < DEDUP_WINDOW_MS

        const status = !trimmed ? 'suppressed' : heartbeatOk ? 'suppressed' : isDeduped ? 'deduped' : 'ok'
        let delivered = false
        if (status === 'ok') {
          delivered = await this._deliverCronResult(job, trimmed)
          await this._persistSession(result)
        }

        const runEndedAt = Date.now()
        await this.config.cronDb.updateCronJob(job.id, {
          lastRunAt: startedAt,
          nextRunAt: computeNextRunAt(job, startedAt),
          lastRunStatus: status,
          lastError: null,
          lastDurationMs: runEndedAt - startedAt,
          lastResponseHash: trimmed ? hash : job.lastResponseHash,
          lastResponseSentAt: delivered ? runEndedAt : job.lastResponseSentAt,
          consecutiveErrors: 0,
        })
        await this.config.cronDb.insertCronRun({
          jobId: job.id,
          startedAt,
          endedAt: runEndedAt,
          status,
          durationMs: runEndedAt - startedAt,
          responseText: trimmed || null,
          wasHeartbeatOk: heartbeatOk,
          wasDeduped: isDeduped,
          delivered,
          wakeSource: params.source,
        })

        this._emit('cron.job.completed', {
          jobId: job.id,
          status,
          durationMs: runEndedAt - startedAt,
          ...(trimmed ? { responsePreview: trimmed.slice(0, 200) } : {}),
        })
      } catch (err: any) {
        const nextConsecutiveErrors = (job.consecutiveErrors || 0) + 1
        const normalNext = computeNextRunAt(job, startedAt)
        const backoffNext = startedAt + errorBackoffMs(nextConsecutiveErrors)
        const nextRunAt = normalNext ? Math.max(normalNext, backoffNext) : backoffNext

        await this.config.cronDb.updateCronJob(job.id, {
          lastRunAt: startedAt,
          nextRunAt,
          lastRunStatus: 'error',
          lastError: err?.message || 'cron_error',
          lastDurationMs: Date.now() - startedAt,
          consecutiveErrors: nextConsecutiveErrors,
        })
        await this.config.cronDb.insertCronRun({
          jobId: job.id,
          startedAt,
          endedAt: Date.now(),
          status: 'error',
          error: err?.message || 'cron_error',
          wakeSource: params.source,
        })
        this._emit('cron.job.error', {
          jobId: job.id,
          error: err?.message || 'cron_error',
          consecutiveErrors: nextConsecutiveErrors,
        })
      }
    }
  }

  private async _runAgentTurn(params: {
    prompt: string
    skill: CronSkillStoreRecord | null
    sessionKey: string
  }): Promise<AgentRunResult> {
    const provider = 'anthropic'
    const authResult = await withTimeout(
      this.config.getAuth(provider, 'main'),
      WORKER_BRIDGE_TIMEOUT_MS,
      'auth.getToken timeout',
    )
    if (!authResult.apiKey) {
      throw new Error('No API provider configured')
    }

    const promptResult = await withTimeout(
      this.config.getSystemPrompt('main'),
      WORKER_BRIDGE_TIMEOUT_MS,
      'system_prompt.get timeout',
    )

    let agentError: string | null = null
    const runner = new AgentRunner({
      dispatch: (msg) => {
        if (msg.type === 'agent.error') {
          agentError = typeof msg.error === 'string' ? msg.error : 'Agent execution failed'
        }
      },
      toolProxy: this.config.toolProxy,
    })

    const model = params.skill?.model || 'claude-sonnet-4-5'
    const timeoutMs = Math.max(1_000, Number(params.skill?.timeoutMs) || 60_000)
    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      await Promise.race([
        runner.run({
          prompt: params.prompt,
          agentId: 'main',
          sessionKey: params.sessionKey,
          apiKey: authResult.apiKey,
          provider,
          systemPrompt: params.skill?.systemPrompt || promptResult.systemPrompt,
          model,
          maxTurns: params.skill?.maxTurns ?? 3,
          allowedTools: params.skill?.allowedTools,
          extraTools: this.config.extraTools,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            runner.abort()
            reject(new Error(`Agent run timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (agentError) {
      throw new Error(agentError)
    }

    const messages = (runner.currentAgent?.state.messages as any[]) || []
    return {
      text: extractLastAssistantText(messages),
      sessionKey: params.sessionKey,
      messages,
      model,
    }
  }

  private async _persistSession(result: AgentRunResult): Promise<void> {
    if (!result.messages.length) return
    try {
      await this.sessionStore.saveSession({
        sessionKey: result.sessionKey,
        agentId: 'main',
        messages: result.messages,
        model: `anthropic/${result.model}`,
        startTime: Date.now(),
      })
    } catch (err: any) {
      console.warn('[HeartbeatManager] Failed to persist session:', err?.message)
    }
  }

  private async _deliverCronResult(job: CronJobStoreRecord, text: string): Promise<boolean> {
    if (!text || job.deliveryMode === 'none') return false

    if (job.deliveryMode === 'webhook' && job.deliveryWebhookUrl) {
      try {
        const response = await fetch(job.deliveryWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: job.id,
            jobName: job.name,
            text,
            sentAt: Date.now(),
          }),
        })
        if (response.ok) return true
      } catch {
        // Fall back to a local notification event.
      }
    }

    this._emit('cron.notification', {
      title: job.deliveryNotificationTitle || job.name,
      body: text,
      jobId: job.id,
      source: 'cron',
    })
    return true
  }

  private async _resolveSkill(skillId?: string): Promise<CronSkillStoreRecord | null> {
    if (!skillId) return null
    const skills = await this.config.cronDb.listCronSkills()
    return skills.find((skill) => skill.id === skillId) || null
  }

  private async _emitSchedulerStatus(): Promise<void> {
    const scheduler = await this.config.cronDb.getSchedulerConfig()
    const heartbeat = await this.config.cronDb.getHeartbeatConfig()
    const dueJobs = await this.config.cronDb.getDueJobs(Date.now())
    this._emit('scheduler.status', {
      enabled: scheduler.enabled,
      mode: scheduler.schedulingMode || 'balanced',
      heartbeatNext: heartbeat.nextRunAt,
      nextDueAt: dueJobs[0]?.nextRunAt,
    })
  }

  private async _consumePendingEvents(events: PendingSystemEvent[]): Promise<void> {
    if (!events.length) return
    await this.config.cronDb.consumePendingEvents(events.map((event) => event.id))
  }

  private _emit(type: string, payload: Record<string, unknown> = {}): void {
    this.config.dispatch({ type, ...payload })
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function extractLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part?.text || '')
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

export function buildHeartbeatPrompt(basePrompt: string, pendingEvents: PendingSystemEvent[]): string {
  if (!pendingEvents.length) return basePrompt
  const lines = pendingEvents.map((event) => {
    const timestamp = new Date(event.createdAt).toISOString()
    const contextKey = event.contextKey ? ` (${event.contextKey})` : ''
    return `- [${timestamp}]${contextKey} ${event.text}`
  })
  return `${basePrompt}\n\nSystem events:\n${lines.join('\n')}`
}

export function computeNextRunAt(job: Pick<CronJobStoreRecord, 'schedule'>, nowMs: number): number | null {
  const schedule = job.schedule || {}
  if (schedule.kind === 'every') {
    const everyMs = Number(schedule.everyMs) || 0
    return everyMs > 0 ? nowMs + everyMs : null
  }
  if (schedule.kind === 'at') {
    const atMs = Number(schedule.atMs) || 0
    return atMs > nowMs ? atMs : null
  }
  return null
}

export function isHeartbeatOk(text: string): boolean {
  const trimmed = (text || '').trim()
  if (!trimmed) return true
  return HEARTBEAT_OK_TOKENS.some((token) => trimmed === token || trimmed.startsWith(`${token}\n`))
}

export function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function errorBackoffMs(consecutiveErrors: number): number {
  const index = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
  return ERROR_BACKOFF_MS[Math.max(0, index)]
}

function parseActiveHoursMinutes(raw?: string, allow24 = false): number | null {
  if (typeof raw !== 'string') return null
  const match = raw.trim().match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour === 24) {
    if (!allow24 || minute !== 0) return null
    return 24 * 60
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function resolveMinutesInTimeZone(nowMs: number, tz?: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs))
    const values: Record<string, string> = {}
    for (const part of parts) {
      if (part.type !== 'literal') values[part.type] = part.value
    }
    const hour = Number(values.hour)
    const minute = Number(values.minute)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return hour * 60 + minute
  } catch {
    return null
  }
}

export function isWithinActiveHours(start?: string, end?: string, tz?: string, nowMs = Date.now()): boolean {
  if (!start || !end) return true
  const startMin = parseActiveHoursMinutes(start, false)
  const endMin = parseActiveHoursMinutes(end, true)
  if (startMin === null || endMin === null) return true
  if (startMin === endMin) return false

  const currentMin = resolveMinutesInTimeZone(nowMs, tz || 'UTC')
  if (currentMin === null) return true

  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin
  }
  return currentMin >= startMin || currentMin < endMin
}
