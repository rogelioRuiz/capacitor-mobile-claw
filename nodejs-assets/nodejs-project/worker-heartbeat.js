import { existsSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import {
  isDbReady,
  run as dbRun,
  queryOne as dbQueryOne,
  flush as dbFlush,
  getSchedulerConfig,
  getHeartbeatConfig,
  setHeartbeatConfig,
  listCronSkills,
  listCronJobs,
  getDueJobs,
  updateCronJob,
  insertCronRun,
  enqueueSystemEvent,
  peekPendingEvents,
  consumePendingEvents,
} from './worker-db.js';

const DEFAULT_HEARTBEAT_PROMPT =
  'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';

const HEARTBEAT_OK_TOKENS = ['HEARTBEAT_OK', 'heartbeat_ok', 'ok', 'OK', '✓', '👍'];
const ERROR_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

let deps = null;
let wakeInFlight = false;
let heartbeatConsecutiveErrors = 0;

export function initHeartbeat(initDeps) {
  deps = {
    ...initDeps,
  };
}

export async function handleHeartbeatWake(source = 'manual', opts = {}) {
  if (!deps || !deps.channel) return;
  if (wakeInFlight) {
    _emit('heartbeat.skipped', { reason: 'busy' });
    return;
  }

  wakeInFlight = true;
  try {
    const scheduler = getSchedulerConfig();
    const isManual = source === 'manual' || opts.force === true;

    if (!isManual && !scheduler?.enabled) {
      _emit('heartbeat.skipped', { reason: 'scheduler_disabled' });
      _emitSchedulerStatus({ scheduler });
      return;
    }

    if (!isManual && deps.isUserTurnActive?.()) {
      _emit('heartbeat.skipped', { reason: 'user_active' });
      _emitSchedulerStatus({ scheduler });
      return;
    }

    _emit('heartbeat.started', { source });

    const now = Date.now();
    const heartbeatResult = await _runHeartbeatCycle({
      source,
      now,
      force: isManual || opts.force === true,
      forceSessionKey: opts.forceSessionKey,
    });

    await _runDueCronJobs({
      source,
      now,
      forceJobId: opts.forceJobId,
    });

    const durationMs = Date.now() - now;
    if (heartbeatResult.status === 'skipped') {
      _emit('heartbeat.skipped', { reason: heartbeatResult.reason || 'not_due' });
    } else {
      _emit('heartbeat.completed', {
        status: heartbeatResult.status,
        reason: heartbeatResult.reason,
        durationMs,
        ...(heartbeatResult.responsePreview
          ? { responsePreview: heartbeatResult.responsePreview }
          : {}),
      });
    }

    _emitSchedulerStatus({ scheduler: getSchedulerConfig() });
  } catch (err) {
    const durationMs = 0;
    _emit('heartbeat.completed', {
      status: 'error',
      reason: err?.message || 'heartbeat_failed',
      durationMs,
    });
  } finally {
    wakeInFlight = false;
  }
}

function _emit(type, payload = {}) {
  deps.channel.send('message', { type, ...payload });
}

function _emitSchedulerStatus({ scheduler }) {
  const heartbeat = getHeartbeatConfig();
  const dueJobs = getDueJobs(Date.now());
  _emit('scheduler.status', {
    enabled: !!scheduler?.enabled,
    mode: scheduler?.schedulingMode || 'balanced',
    heartbeatNext: heartbeat?.nextRunAt,
    nextDueAt: dueJobs[0]?.nextRunAt,
  });
}

async function _runHeartbeatCycle(params) {
  const now = params.now ?? Date.now();
  const config = getHeartbeatConfig();
  if (!params.force && !config?.enabled) {
    return { status: 'skipped', reason: 'heartbeat_disabled' };
  }

  if (!params.force && config.nextRunAt && now < config.nextRunAt) {
    return { status: 'skipped', reason: 'not_due' };
  }

  if (!isWithinActiveHours(
    config.activeHours?.start,
    config.activeHours?.end,
    config.activeHours?.tz
  )) {
    const nextRunAt = now + Math.max(15_000, Number(config.everyMs) || 1_800_000);
    setHeartbeatConfig({ nextRunAt });
    return { status: 'skipped', reason: 'outside_active_hours' };
  }

  const heartbeatSkill = _resolveSkill(config.skillId);
  const sessionKey =
    params.forceSessionKey || deps.getCurrentSessionKey?.() || `main/${Date.now()}`;

  const pendingEvents = peekPendingEvents(sessionKey);
  const prompt = _buildHeartbeatPrompt({
    basePrompt: config.prompt || DEFAULT_HEARTBEAT_PROMPT,
    pendingEvents,
  });

  const transcriptState = captureTranscriptState('main', sessionKey, deps.OPENCLAW_ROOT);
  const startedAt = Date.now();

  try {
    const runResult = await _runHeartbeatTurn({
      prompt,
      heartbeatSkill,
    });

    const text = runResult.text || '';
    const trimmed = text.trim();
    const hash = fnv1aHash(trimmed);
    const isOk = isHeartbeatOk(trimmed);
    const isDuplicate =
      !!trimmed &&
      !!config.lastHash &&
      config.lastHash === hash &&
      !!config.lastSentAt &&
      startedAt - config.lastSentAt < 24 * 60 * 60 * 1000;

    if (!trimmed || isOk || isDuplicate) {
      if (runResult.agent && typeof runResult.preMessageCount === 'number') {
        _pruneInMemoryMessages(runResult.agent, runResult.preMessageCount);
      }
      pruneHeartbeatTranscript(transcriptState, sessionKey);
      if (pendingEvents.length > 0) {
        consumePendingEvents(pendingEvents.map((e) => e.id));
      }
      setHeartbeatConfig({
        nextRunAt: startedAt + (Number(config.everyMs) || 1_800_000),
      });

      heartbeatConsecutiveErrors = 0;
      if (isDuplicate) {
        return { status: 'deduped', reason: 'duplicate' };
      }
      if (isOk) {
        return { status: 'suppressed', reason: 'heartbeat_ok' };
      }
      return { status: 'suppressed', reason: 'empty' };
    }

    heartbeatConsecutiveErrors = 0;
    if (runResult.usedExistingAgent) {
      deps.persistCurrentSession?.(startedAt, 'main', sessionKey);
    } else if (runResult.agent) {
      _persistEphemeralAgentSession(runResult.agent, sessionKey, startedAt);
    }

    _emit('cron.notification', {
      title: 'Sentinel heartbeat',
      body: trimmed,
      source: 'heartbeat',
    });

    if (pendingEvents.length > 0) {
      consumePendingEvents(pendingEvents.map((e) => e.id));
    }

    setHeartbeatConfig({
      nextRunAt: startedAt + (Number(config.everyMs) || 1_800_000),
      lastHash: hash,
      lastSentAt: startedAt,
    });

    return {
      status: 'ok',
      responsePreview: trimmed.slice(0, 240),
    };
  } catch (err) {
    heartbeatConsecutiveErrors += 1;
    const normalNext = startedAt + (Number(config.everyMs) || 1_800_000);
    const backoffNext = startedAt + errorBackoffMs(heartbeatConsecutiveErrors);
    setHeartbeatConfig({ nextRunAt: Math.max(normalNext, backoffNext) });
    return { status: 'error', reason: err?.message || 'heartbeat_error' };
  }
}

async function _runDueCronJobs(params) {
  const now = params.now ?? Date.now();
  const skills = listCronSkills();
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const allJobs = listCronJobs();
  const dueJobs = params.forceJobId
    ? allJobs.filter((job) => job.id === params.forceJobId)
    : getDueJobs(now);

  for (const job of dueJobs) {
    const startedAt = Date.now();
    const skill = skillById.get(job.skillId) || null;

    if (!job.enabled) continue;

    if (!isWithinActiveHours(job.activeHours?.start, job.activeHours?.end, job.activeHours?.tz)) {
      const nextRunAt = _computeNextRunAt(job, now);
      updateCronJob(job.id, {
        lastRunAt: startedAt,
        nextRunAt,
        lastRunStatus: 'skipped',
      });
      insertCronRun({
        jobId: job.id,
        startedAt,
        endedAt: Date.now(),
        status: 'skipped',
        wakeSource: params.source,
      });
      continue;
    }

    _emit('cron.job.started', { jobId: job.id, jobName: job.name });

    try {
      if (job.sessionTarget === 'main') {
        const sessionKey = deps.getCurrentSessionKey?.() || `main/${Date.now()}`;
        const contextKey = `cron:${job.id}:${startedAt}`;
        enqueueSystemEvent(sessionKey, contextKey, job.prompt);

        if (job.wakeMode === 'now' || params.forceJobId === job.id) {
          await _runHeartbeatCycle({
            source: `cron:${job.id}`,
            now: Date.now(),
            force: true,
            forceSessionKey: sessionKey,
          });
        }

        const nextRunAt = _computeNextRunAt(job, startedAt);
        updateCronJob(job.id, {
          lastRunAt: startedAt,
          nextRunAt,
          lastRunStatus: 'ok',
          lastError: null,
          lastDurationMs: Date.now() - startedAt,
          consecutiveErrors: 0,
        });

        insertCronRun({
          jobId: job.id,
          startedAt,
          endedAt: Date.now(),
          status: 'ok',
          responseText: 'Enqueued to main session heartbeat.',
          delivered: false,
          wakeSource: params.source,
        });

        _emit('cron.job.completed', {
          jobId: job.id,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          responsePreview: 'Queued for heartbeat',
        });
        continue;
      }

      const resultText = await _runIsolatedCronJob({
        job,
        skill,
      });
      const trimmed = (resultText || '').trim();
      const hash = fnv1aHash(trimmed);

      const isDeduped =
        !!trimmed &&
        !!job.lastResponseHash &&
        job.lastResponseHash === hash &&
        !!job.lastResponseSentAt &&
        startedAt - job.lastResponseSentAt < 24 * 60 * 60 * 1000;

      const status = !trimmed
        ? 'suppressed'
        : isHeartbeatOk(trimmed)
          ? 'suppressed'
          : isDeduped
            ? 'deduped'
            : 'ok';

      let delivered = false;
      if (status === 'ok') {
        delivered = await _deliverCronResult(job, trimmed);
      }

      const nextRunAt = _computeNextRunAt(job, startedAt);
      const runEndedAt = Date.now();

      updateCronJob(job.id, {
        lastRunAt: startedAt,
        nextRunAt,
        lastRunStatus: status,
        lastError: null,
        lastDurationMs: runEndedAt - startedAt,
        lastResponseHash: trimmed ? hash : job.lastResponseHash,
        lastResponseSentAt: delivered ? runEndedAt : job.lastResponseSentAt,
        consecutiveErrors: 0,
      });

      insertCronRun({
        jobId: job.id,
        startedAt,
        endedAt: runEndedAt,
        status,
        durationMs: runEndedAt - startedAt,
        responseText: trimmed || null,
        wasHeartbeatOk: isHeartbeatOk(trimmed),
        wasDeduped: isDeduped,
        delivered,
        wakeSource: params.source,
      });

      _emit('cron.job.completed', {
        jobId: job.id,
        status,
        durationMs: runEndedAt - startedAt,
        ...(trimmed ? { responsePreview: trimmed.slice(0, 200) } : {}),
      });
    } catch (err) {
      const nextConsecutiveErrors = (job.consecutiveErrors || 0) + 1;
      const normalNext = _computeNextRunAt(job, startedAt);
      const backoffNext = startedAt + errorBackoffMs(nextConsecutiveErrors);
      const nextRunAt = normalNext ? Math.max(normalNext, backoffNext) : backoffNext;

      updateCronJob(job.id, {
        lastRunAt: startedAt,
        nextRunAt,
        lastRunStatus: 'error',
        lastError: err?.message || 'cron_error',
        lastDurationMs: Date.now() - startedAt,
        consecutiveErrors: nextConsecutiveErrors,
      });

      insertCronRun({
        jobId: job.id,
        startedAt,
        endedAt: Date.now(),
        status: 'error',
        error: err?.message || 'cron_error',
        wakeSource: params.source,
      });

      _emit('cron.job.error', {
        jobId: job.id,
        error: err?.message || 'cron_error',
        consecutiveErrors: nextConsecutiveErrors,
      });
    }
  }
}

async function _runHeartbeatTurn({ prompt, heartbeatSkill }) {
  const existingAgent = deps.getCurrentAgent?.();
  if (existingAgent) {
    const preMessageCount = existingAgent.state.messages.length;
    await existingAgent.prompt(prompt);
    await existingAgent.waitForIdle();
    return {
      text: _extractLastAssistantText(existingAgent.state.messages),
      agent: existingAgent,
      preMessageCount,
      usedExistingAgent: true,
    };
  }

  const agent = await _createUnattendedAgent({
    skill: heartbeatSkill,
  });
  await agent.prompt(prompt);
  await agent.waitForIdle();
  return {
    text: _extractLastAssistantText(agent.state.messages),
    agent,
    preMessageCount: 0,
    usedExistingAgent: false,
  };
}

async function _runIsolatedCronJob({ job, skill }) {
  const agent = await _createUnattendedAgent({ skill });
  await agent.prompt(job.prompt);
  await agent.waitForIdle();
  return _extractLastAssistantText(agent.state.messages);
}

async function _createUnattendedAgent({ skill }) {
  await deps.refreshOAuthTokenIfNeeded?.('main');
  const authProfiles = deps.loadAuthProfiles?.('main');
  const apiKey = deps.resolveApiKey?.(authProfiles);
  if (!apiKey) {
    throw new Error('No API provider configured');
  }

  const allowedTools = Array.isArray(skill?.allowedTools) ? skill.allowedTools : null;
  const localTools = deps.buildAutoApproveTools(allowedTools);
  const mcpRaw = await deps.discoverMcpTools();
  const mcpTools = allowedTools
    ? mcpRaw.filter((tool) => allowedTools.includes(tool.name))
    : mcpRaw;
  const tools = [...localTools, ...mcpTools];

  const modelId = skill?.model || 'claude-sonnet-4-5';
  const model = deps.getModel('anthropic', modelId);
  const systemPrompt = skill?.systemPrompt || deps.loadSystemPrompt();

  return new deps.Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      thinkingLevel: 'off',
      ...(skill?.maxTurns ? { maxTurns: skill.maxTurns } : {}),
    },
    convertToLlm: (messages) =>
      messages.filter(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
      ),
    getApiKey: () => apiKey,
  });
}

function _persistEphemeralAgentSession(agent, sessionKey, startedAt) {
  if (!isDbReady()) return;
  const usage = _extractUsage(agent);
  const messages = agent.state?.messages || [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    dbRun(
      `INSERT OR IGNORE INTO messages
       (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionKey,
        i,
        m.role,
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        m.timestamp || null,
        m.model || null,
        m.toolCallId || null,
        m.usage?.input || null,
        m.usage?.output || null,
      ]
    );
  }

  dbRun(
    `INSERT OR REPLACE INTO sessions
     (session_key, agent_id, created_at, updated_at, model, total_tokens, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionKey,
      'main',
      startedAt,
      Date.now(),
      'anthropic/claude-sonnet-4-5',
      usage.totalTokens,
      usage.inputTokens,
      usage.outputTokens,
    ]
  );

  dbFlush();
}

function _pruneInMemoryMessages(agent, keepCount) {
  if (!agent || typeof keepCount !== 'number') return;
  const current = Array.isArray(agent.state?.messages) ? agent.state.messages : [];
  if (current.length <= keepCount) return;
  const trimmed = current.slice(0, keepCount);
  if (typeof agent.replaceMessages === 'function') {
    agent.replaceMessages(trimmed);
    return;
  }
  if (agent.state) {
    agent.state.messages = trimmed;
  }
}

function _extractUsage(agent) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const msg of agent.state?.messages || []) {
    if (msg.role === 'assistant' && msg.usage) {
      inputTokens += msg.usage.input || 0;
      outputTokens += msg.usage.output || 0;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function _extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text || '')
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

function _buildHeartbeatPrompt({ basePrompt, pendingEvents }) {
  if (!pendingEvents || pendingEvents.length === 0) return basePrompt;
  const lines = pendingEvents.map((event) => {
    const ts = new Date(event.createdAt).toISOString();
    const key = event.contextKey ? ` (${event.contextKey})` : '';
    return `- [${ts}]${key} ${event.text}`;
  });
  return `${basePrompt}\n\nSystem events:\n${lines.join('\n')}`;
}

function _resolveSkill(skillId) {
  if (!skillId) return null;
  const skills = listCronSkills();
  return skills.find((s) => s.id === skillId) || null;
}

function _computeNextRunAt(job, nowMs) {
  const schedule = job.schedule || {};
  if (schedule.kind === 'every') {
    const everyMs = Number(schedule.everyMs) || 0;
    return everyMs > 0 ? nowMs + everyMs : null;
  }
  if (schedule.kind === 'at') {
    const atMs = Number(schedule.atMs) || 0;
    return atMs > nowMs ? atMs : null;
  }
  return null;
}

async function _deliverCronResult(job, text) {
  if (!text || job.deliveryMode === 'none') return false;

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
      });
      if (response.ok) return true;
    } catch {
      // Fall back to local notification event below.
    }
  }

  _emit('cron.notification', {
    title: job.deliveryNotificationTitle || job.name,
    body: text,
    jobId: job.id,
    source: 'cron',
  });
  return true;
}

export function captureTranscriptState(agentId, sessionKey, openclawRoot = deps?.OPENCLAW_ROOT) {
  const jsonlPath = openclawRoot
    ? join(openclawRoot, 'agents', agentId, 'sessions', `${sessionKey.replace('/', '_')}.jsonl`)
    : null;

  let jsonlSize = null;
  if (jsonlPath && existsSync(jsonlPath)) {
    try {
      jsonlSize = statSync(jsonlPath).size;
    } catch {
      jsonlSize = null;
    }
  }

  if (!isDbReady()) {
    return {
      sessionKey,
      jsonlPath,
      jsonlSize,
      maxMessageSeq: -1,
      sessionUpdatedAt: null,
    };
  }

  const maxRow = dbQueryOne('SELECT MAX(sequence) as max_seq FROM messages WHERE session_key = ?', [
    sessionKey,
  ]);
  const maxMessageSeq = Number.isFinite(maxRow?.max_seq) ? maxRow.max_seq : -1;

  const sessionRow = dbQueryOne('SELECT updated_at FROM sessions WHERE session_key = ?', [sessionKey]);

  return {
    sessionKey,
    jsonlPath,
    jsonlSize,
    maxMessageSeq,
    sessionUpdatedAt:
      typeof sessionRow?.updated_at === 'number' ? sessionRow.updated_at : null,
  };
}

export function pruneHeartbeatTranscript(state, sessionKey = state?.sessionKey) {
  if (!state || !sessionKey) return;

  if (state.jsonlPath && typeof state.jsonlSize === 'number') {
    try {
      if (existsSync(state.jsonlPath)) {
        const size = statSync(state.jsonlPath).size;
        if (size > state.jsonlSize) {
          truncateSync(state.jsonlPath, state.jsonlSize);
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  if (isDbReady()) {
    dbRun('DELETE FROM messages WHERE session_key = ? AND sequence > ?', [
      sessionKey,
      typeof state.maxMessageSeq === 'number' ? state.maxMessageSeq : -1,
    ]);

    if (typeof state.sessionUpdatedAt === 'number') {
      dbRun('UPDATE sessions SET updated_at = ? WHERE session_key = ?', [
        state.sessionUpdatedAt,
        sessionKey,
      ]);
    }
    dbFlush();
  }
}

export function isHeartbeatOk(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  return HEARTBEAT_OK_TOKENS.some(
    (token) => trimmed === token || trimmed.startsWith(`${token}\n`)
  );
}

export function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function errorBackoffMs(consecutiveErrors) {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1);
  return ERROR_BACKOFF_MS[Math.max(0, idx)];
}

function _parseActiveHoursMinutes(raw, allow24 = false) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 24) {
    if (!allow24 || minute !== 0) return null;
    return 24 * 60;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function _resolveMinutesInTimeZone(nowMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const map = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

export function isWithinActiveHours(start, end, tz, nowMs = Date.now()) {
  if (!start || !end) return true;
  const startMin = _parseActiveHoursMinutes(start, false);
  const endMin = _parseActiveHoursMinutes(end, true);
  if (startMin === null || endMin === null) return true;
  if (startMin === endMin) return false;

  const currentMin = _resolveMinutesInTimeZone(nowMs, tz || 'UTC');
  if (currentMin === null) return true;

  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  return currentMin >= startMin || currentMin < endMin;
}
