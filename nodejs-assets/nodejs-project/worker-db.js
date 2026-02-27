/**
 * worker-db.js — SQLite persistence layer for mobile-claw Node.js worker.
 *
 * Uses sql.js (WASM SQLite) for ACID transactions, crash-safe writes,
 * and structured queries. Replaces raw JSONL/JSON file persistence.
 *
 * Architecture:
 * - sql.js operates in-memory; we persist to disk via atomic tmp+rename
 * - flush() exports the full DB and writes atomically (survives OOM kill)
 * - Auto-flush every 5s to limit data loss window
 * - On init, loads existing DB file or creates fresh
 */

import { createRequire } from 'node:module';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

// sql.js uses require-style exports; ESM import needs createRequire
const _require = createRequire(import.meta.url);

let db = null;
let dbPath = null;
let flushTimer = null;
let _ready = false;

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_MAX_RETRIES = 3;
const SCHEMA_VERSION = 2;

// ── Schema ──────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model TEXT,
  total_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER,
  model TEXT,
  tool_call_id TEXT,
  usage_input INTEGER,
  usage_output INTEGER,
  UNIQUE(session_key, sequence)
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_key, sequence);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);
`;

// ── Atomic file write helper ────────────────────────────────────────────

export function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp';
  const fd = openSync(tmpPath, 'w');
  try {
    if (typeof data === 'string') {
      writeSync(fd, data);
    } else {
      // Buffer / Uint8Array
      writeSync(fd, data, 0, data.length);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Initialize the SQLite database.
 * @param {string} openclawRoot - Root data directory ($OPENCLAW_ROOT)
 */
export async function initWorkerDb(openclawRoot) {
  if (_ready) return;

  dbPath = join(openclawRoot, 'mobile-claw.db');
  mkdirSync(openclawRoot, { recursive: true });

  // Load sql.js — skip entirely if WebAssembly is unavailable (Capacitor-NodeJS v18)
  // sql.js's WASM and asm.js builds both use Emscripten which references WebAssembly
  // globals at load time, so we can't even require() it without a real WASM runtime.
  // The caller (main.js) falls back to JSONL persistence when initWorkerDb throws.
  if (typeof WebAssembly === 'undefined' || globalThis.WebAssembly?._isStub) {
    throw new Error('WebAssembly is not available — using JSONL fallback');
  }

  let SQL;
  try {
    const initSqlJs = _require('sql.js');
    const wasmPath = join(
      dirname(_require.resolve('sql.js')),
      'sql-wasm.wasm'
    );
    SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
  } catch (wasmErr) {
    console.warn(`[worker-db] WASM init failed (${wasmErr.message}), trying asm.js fallback`);
    try {
      const initSqlJsAsm = _require('sql.js/dist/sql-asm.js');
      SQL = await initSqlJsAsm();
    } catch (asmErr) {
      console.error(`[worker-db] Both WASM and asm.js failed:`, asmErr.message);
      throw asmErr;
    }
  }

  // Open existing DB or create new
  if (existsSync(dbPath)) {
    try {
      const fileBuffer = readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      console.log(`[worker-db] Loaded existing DB (${fileBuffer.length} bytes)`);
    } catch (err) {
      console.warn(`[worker-db] DB file corrupt (${err.message}), creating fresh`);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log(`[worker-db] Created new DB`);
  }

  // Clean up stale tmp file if it exists (crash during previous flush)
  const tmpPath = dbPath + '.tmp';
  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  // Run schema
  db.run(SCHEMA_SQL);

  // Check and apply migrations
  _migrate();

  // Evict old sessions and trim oversized ones
  _evictOldSessions();

  // Start auto-flush timer
  flushTimer = setInterval(() => {
    try { flush(); } catch (err) {
      console.warn(`[worker-db] Auto-flush failed: ${err.message}`);
    }
  }, FLUSH_INTERVAL_MS);

  _ready = true;
  console.log(`[worker-db] SQLite initialized (v${SCHEMA_VERSION})`);
}

/**
 * Check if the DB is ready for use.
 */
export function isDbReady() {
  return _ready && db !== null;
}

/**
 * Execute a SQL statement (INSERT, UPDATE, DELETE, CREATE).
 * @param {string} sql
 * @param {any[]} [params]
 */
export function run(sql, params) {
  if (!db) throw new Error('[worker-db] DB not initialized');
  db.run(sql, params);
}

/**
 * Query rows from the database.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Object[]} Array of row objects
 */
export function query(sql, params) {
  if (!db) throw new Error('[worker-db] DB not initialized');
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Query a single row.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Object|null}
 */
export function queryOne(sql, params) {
  const rows = query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Run multiple statements inside a transaction.
 * Rolls back on error. Returns the result of the callback.
 * @param {Function} fn - Callback that calls run()/query()
 * @returns {*} Result of fn()
 */
export function transaction(fn) {
  if (!db) throw new Error('[worker-db] DB not initialized');
  db.run('BEGIN TRANSACTION');
  try {
    const result = fn();
    db.run('COMMIT');
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Persist the in-memory database to disk atomically.
 * Uses tmp+rename+fsync pattern for crash safety.
 */
export function flush() {
  if (!db || !dbPath) return;

  const data = db.export();
  const buffer = Buffer.from(data);

  let lastErr;
  for (let attempt = 0; attempt < FLUSH_MAX_RETRIES; attempt++) {
    try {
      atomicWrite(dbPath, buffer);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < FLUSH_MAX_RETRIES - 1) {
        // Brief sync delay before retry
        const start = Date.now();
        while (Date.now() - start < 100) { /* spin wait — no setTimeout in sync context */ }
      }
    }
  }
  throw lastErr;
}

/**
 * Close the database and stop auto-flush.
 */
export function close() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (db) {
    try { flush(); } catch { /* best effort */ }
    db.close();
    db = null;
  }
  _ready = false;
}

// ── Migration ───────────────────────────────────────────────────────────

function _migrate() {
  const row = queryOne('SELECT MAX(version) as v FROM schema_version');
  const currentVersion = row?.v || 0;

  if (currentVersion < 1) {
    // Schema already created above via SCHEMA_SQL
    run('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [1]);
    console.log(`[worker-db] Migrated to v1`);
  }

  if (currentVersion < 2) {
    run(
      `CREATE TABLE IF NOT EXISTS cron_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        allowed_tools TEXT,
        system_prompt TEXT,
        model TEXT,
        max_turns INTEGER DEFAULT 3,
        timeout_ms INTEGER DEFAULT 60000,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );

    run(
      `CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        session_target TEXT NOT NULL DEFAULT 'isolated',
        wake_mode TEXT DEFAULT 'next-heartbeat',
        schedule_kind TEXT NOT NULL,
        schedule_every_ms INTEGER,
        schedule_anchor_ms INTEGER,
        schedule_at_ms INTEGER,
        skill_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        delivery_mode TEXT NOT NULL DEFAULT 'notification',
        delivery_webhook_url TEXT,
        delivery_notification_title TEXT,
        active_hours_start TEXT,
        active_hours_end TEXT,
        active_hours_tz TEXT,
        last_run_at INTEGER,
        next_run_at INTEGER,
        last_run_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        last_response_hash TEXT,
        last_response_sent_at INTEGER,
        consecutive_errors INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
    run('CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run_at ON cron_jobs(enabled, next_run_at)');

    run(
      `CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT,
        duration_ms INTEGER,
        error TEXT,
        response_text TEXT,
        was_heartbeat_ok INTEGER DEFAULT 0,
        was_deduped INTEGER DEFAULT 0,
        delivered INTEGER DEFAULT 0,
        wake_source TEXT
      )`
    );
    run('CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_id, started_at DESC)');

    run(
      `CREATE TABLE IF NOT EXISTS heartbeat_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 0,
        every_ms INTEGER NOT NULL DEFAULT 1800000,
        prompt TEXT,
        skill_id TEXT,
        active_hours_start TEXT,
        active_hours_end TEXT,
        active_hours_tz TEXT,
        next_run_at INTEGER,
        last_heartbeat_hash TEXT,
        last_heartbeat_sent_at INTEGER,
        updated_at INTEGER NOT NULL
      )`
    );

    run(
      `CREATE TABLE IF NOT EXISTS scheduler_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        scheduling_mode TEXT NOT NULL DEFAULT 'balanced',
        run_on_charging INTEGER NOT NULL DEFAULT 1,
        global_active_hours_start TEXT,
        global_active_hours_end TEXT,
        global_active_hours_tz TEXT,
        updated_at INTEGER NOT NULL
      )`
    );

    run(
      `CREATE TABLE IF NOT EXISTS system_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        context_key TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      )`
    );
    run('CREATE INDEX IF NOT EXISTS idx_system_events_pending ON system_events(session_key, consumed, created_at)');

    const now = Date.now();
    run(
      `INSERT OR IGNORE INTO heartbeat_config
       (id, enabled, every_ms, updated_at)
       VALUES (1, 0, 1800000, ?)`,
      [now]
    );
    run(
      `INSERT OR IGNORE INTO scheduler_config
       (id, enabled, scheduling_mode, run_on_charging, updated_at)
       VALUES (1, 1, 'balanced', 1, ?)`,
      [now]
    );
    run('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [2]);
    console.log('[worker-db] Migrated to v2');
  }
}

// ── Session eviction + size management ──────────────────────────────────

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_MESSAGES_PER_SESSION = 5000;

function _evictOldSessions() {
  try {
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;

    // Delete messages for expired sessions
    const expired = query('SELECT session_key FROM sessions WHERE updated_at < ?', [cutoff]);
    if (expired.length > 0) {
      run('DELETE FROM messages WHERE session_key IN (SELECT session_key FROM sessions WHERE updated_at < ?)', [cutoff]);
      run('DELETE FROM sessions WHERE updated_at < ?', [cutoff]);
      console.log(`[worker-db] Evicted ${expired.length} sessions older than 30 days`);
    }

    // Trim oversized sessions (keep newest messages)
    const large = query(
      `SELECT session_key, COUNT(*) as cnt FROM messages
       GROUP BY session_key HAVING cnt > ?`,
      [MAX_MESSAGES_PER_SESSION]
    );
    for (const row of large) {
      const excess = row.cnt - MAX_MESSAGES_PER_SESSION;
      run(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE session_key = ?
           ORDER BY sequence ASC LIMIT ?
         )`,
        [row.session_key, excess]
      );
      console.log(`[worker-db] Trimmed ${excess} old messages from session ${row.session_key}`);
    }

    if (expired.length > 0 || large.length > 0) {
      flush();
    }
  } catch (err) {
    console.warn(`[worker-db] Eviction failed (non-fatal): ${err.message}`);
  }
}

// ── JSONL Migration (Phase 3) ───────────────────────────────────────────

/**
 * Import existing JSONL session files into SQLite.
 * Called once on first run after upgrade.
 * @param {string} openclawRoot
 * @param {string} agentId
 * @param {Function} deduplicateMessages - existing dedup function from main.js
 */
export function migrateFromJsonl(openclawRoot, agentId, deduplicateMessages) {
  // Check if migration already done
  const migrated = queryOne('SELECT value FROM config WHERE key = ?', ['jsonl_migration_done']);
  if (migrated) return;

  const sessionsDir = join(openclawRoot, 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');

  // Load session index
  let sessionIndex = {};
  try {
    const raw = JSON.parse(readFileSync(sessionsJsonPath, 'utf8'));
    sessionIndex = raw[agentId] || raw;
  } catch {
    // Rebuild from JSONL files
    sessionIndex = _rebuildIndexFromFiles(sessionsDir, agentId);
  }

  const sessionKeys = Object.keys(sessionIndex);
  if (sessionKeys.length === 0) {
    run('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)',
      ['jsonl_migration_done', '1', Date.now()]);
    flush();
    return;
  }

  console.log(`[worker-db] Migrating ${sessionKeys.length} sessions from JSONL...`);

  let totalMessages = 0;

  transaction(() => {
    for (const sessionKey of sessionKeys) {
      const meta = sessionIndex[sessionKey];
      const jsonlFile = join(sessionsDir, `${sessionKey.replace('/', '_')}.jsonl`);

      // Insert session metadata
      run(
        `INSERT OR REPLACE INTO sessions
         (session_key, agent_id, created_at, updated_at, model, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sessionKey,
          agentId,
          meta.createdAt || Date.now(),
          meta.updatedAt || Date.now(),
          meta.model || 'anthropic/claude-sonnet-4-5',
          meta.totalTokens || 0,
        ]
      );

      // Import messages from JSONL
      if (!existsSync(jsonlFile)) continue;

      try {
        const raw = readFileSync(jsonlFile, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        const parsed = [];
        for (const line of lines) {
          try { parsed.push(JSON.parse(line)); }
          catch { /* skip corrupted lines */ }
        }
        const messages = deduplicateMessages(parsed);

        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          run(
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
          totalMessages++;
        }
      } catch (err) {
        console.warn(`[worker-db] Failed to migrate session ${sessionKey}: ${err.message}`);
      }
    }

    run('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)',
      ['jsonl_migration_done', '1', Date.now()]);
  });

  flush();
  console.log(`[worker-db] Migration complete: ${sessionKeys.length} sessions, ${totalMessages} messages`);
}

function _rebuildIndexFromFiles(sessionsDir) {
  const index = {};
  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionKey = file.replace('.jsonl', '').replace('_', '/');
      const stat = statSync(join(sessionsDir, file));
      index[sessionKey] = {
        sessionId: sessionKey,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: stat.mtimeMs,
        model: 'anthropic/claude-sonnet-4-5',
        totalTokens: 0,
      };
    }
  } catch { /* empty index */ }
  return index;
}

// ── Cron/Scheduler/Heartbeat store (Phase 2) ─────────────────────────────

function _toBool(value) {
  return Number(value) === 1;
}

function _toIntBool(value) {
  return value ? 1 : 0;
}

function _parseJsonArray(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function _genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function _mapActiveHours(start, end, tz) {
  if (!start && !end && !tz) return undefined;
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(tz ? { tz } : {}),
  };
}

function _toSchedulerConfig(row) {
  if (!row) return null;
  return {
    enabled: _toBool(row.enabled),
    schedulingMode: row.scheduling_mode || 'balanced',
    runOnCharging: _toBool(row.run_on_charging),
    globalActiveHours: _mapActiveHours(
      row.global_active_hours_start,
      row.global_active_hours_end,
      row.global_active_hours_tz
    ),
    updatedAt: row.updated_at,
  };
}

function _toHeartbeatConfig(row) {
  if (!row) return null;
  return {
    enabled: _toBool(row.enabled),
    everyMs: row.every_ms ?? 1800000,
    prompt: row.prompt || undefined,
    skillId: row.skill_id || undefined,
    activeHours: _mapActiveHours(row.active_hours_start, row.active_hours_end, row.active_hours_tz),
    nextRunAt: row.next_run_at ?? undefined,
    lastHash: row.last_heartbeat_hash || undefined,
    lastSentAt: row.last_heartbeat_sent_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function _toCronSkillRecord(row) {
  return {
    id: row.id,
    name: row.name,
    allowedTools: _parseJsonArray(row.allowed_tools),
    systemPrompt: row.system_prompt || undefined,
    model: row.model || undefined,
    maxTurns: row.max_turns ?? 3,
    timeoutMs: row.timeout_ms ?? 60000,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _toCronJobRecord(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: _toBool(row.enabled),
    sessionTarget: row.session_target || 'isolated',
    wakeMode: row.wake_mode || 'next-heartbeat',
    schedule: {
      kind: row.schedule_kind,
      everyMs: row.schedule_every_ms ?? undefined,
      anchorMs: row.schedule_anchor_ms ?? undefined,
      atMs: row.schedule_at_ms ?? undefined,
    },
    skillId: row.skill_id,
    prompt: row.prompt,
    deliveryMode: row.delivery_mode || 'notification',
    deliveryWebhookUrl: row.delivery_webhook_url || undefined,
    deliveryNotificationTitle: row.delivery_notification_title || undefined,
    activeHours: _mapActiveHours(row.active_hours_start, row.active_hours_end, row.active_hours_tz),
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
  };
}

function _toCronRunRecord(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    status: row.status,
    durationMs: row.duration_ms ?? undefined,
    error: row.error || undefined,
    responseText: row.response_text || undefined,
    wasHeartbeatOk: _toBool(row.was_heartbeat_ok || 0),
    wasDeduped: _toBool(row.was_deduped || 0),
    delivered: _toBool(row.delivered || 0),
    wakeSource: row.wake_source || undefined,
  };
}

function _ensureSchedulerConfigRow() {
  const now = Date.now();
  run(
    `INSERT OR IGNORE INTO scheduler_config
     (id, enabled, scheduling_mode, run_on_charging, updated_at)
     VALUES (1, 1, 'balanced', 1, ?)`,
    [now]
  );
}

function _ensureHeartbeatConfigRow() {
  const now = Date.now();
  run(
    `INSERT OR IGNORE INTO heartbeat_config
     (id, enabled, every_ms, updated_at)
     VALUES (1, 0, 1800000, ?)`,
    [now]
  );
}

function _resolveNextRunAt(schedule, now = Date.now()) {
  if (!schedule || !schedule.kind) return null;
  if (schedule.kind === 'at') return Number(schedule.atMs) || null;
  if (schedule.kind === 'every') {
    const everyMs = Number(schedule.everyMs) || 0;
    if (everyMs <= 0) return null;
    return now + everyMs;
  }
  return null;
}

export function getSchedulerConfig() {
  _ensureSchedulerConfigRow();
  const row = queryOne('SELECT * FROM scheduler_config WHERE id = 1');
  return _toSchedulerConfig(row);
}

export function setSchedulerConfig(patch = {}) {
  _ensureSchedulerConfigRow();
  const sets = [];
  const params = [];

  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(_toIntBool(!!patch.enabled));
  }
  if (patch.schedulingMode !== undefined || patch.scheduling_mode !== undefined) {
    sets.push('scheduling_mode = ?');
    params.push((patch.schedulingMode ?? patch.scheduling_mode) || 'balanced');
  }
  if (patch.runOnCharging !== undefined || patch.run_on_charging !== undefined) {
    sets.push('run_on_charging = ?');
    params.push(_toIntBool(!!(patch.runOnCharging ?? patch.run_on_charging)));
  }

  const globalActiveHours = patch.globalActiveHours || patch.global_active_hours;
  if (globalActiveHours) {
    sets.push('global_active_hours_start = ?');
    params.push(globalActiveHours.start || null);
    sets.push('global_active_hours_end = ?');
    params.push(globalActiveHours.end || null);
    sets.push('global_active_hours_tz = ?');
    params.push(globalActiveHours.tz || globalActiveHours.timezone || null);
  } else {
    if (patch.global_active_hours_start !== undefined) {
      sets.push('global_active_hours_start = ?');
      params.push(patch.global_active_hours_start || null);
    }
    if (patch.global_active_hours_end !== undefined) {
      sets.push('global_active_hours_end = ?');
      params.push(patch.global_active_hours_end || null);
    }
    if (patch.global_active_hours_tz !== undefined) {
      sets.push('global_active_hours_tz = ?');
      params.push(patch.global_active_hours_tz || null);
    }
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(1);

  run(`UPDATE scheduler_config SET ${sets.join(', ')} WHERE id = ?`, params);
  flush();
  return getSchedulerConfig();
}

export function getHeartbeatConfig() {
  _ensureHeartbeatConfigRow();
  const row = queryOne('SELECT * FROM heartbeat_config WHERE id = 1');
  return _toHeartbeatConfig(row);
}

export function setHeartbeatConfig(patch = {}) {
  _ensureHeartbeatConfigRow();
  const sets = [];
  const params = [];

  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(_toIntBool(!!patch.enabled));
  }
  if (patch.everyMs !== undefined || patch.every_ms !== undefined) {
    sets.push('every_ms = ?');
    params.push(Number(patch.everyMs ?? patch.every_ms) || 1800000);
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?');
    params.push(patch.prompt || null);
  }
  if (patch.skillId !== undefined || patch.skill_id !== undefined) {
    sets.push('skill_id = ?');
    params.push((patch.skillId ?? patch.skill_id) || null);
  }

  const activeHours = patch.activeHours || patch.active_hours;
  if (activeHours) {
    sets.push('active_hours_start = ?');
    params.push(activeHours.start || null);
    sets.push('active_hours_end = ?');
    params.push(activeHours.end || null);
    sets.push('active_hours_tz = ?');
    params.push(activeHours.tz || activeHours.timezone || null);
  } else {
    if (patch.active_hours_start !== undefined) {
      sets.push('active_hours_start = ?');
      params.push(patch.active_hours_start || null);
    }
    if (patch.active_hours_end !== undefined) {
      sets.push('active_hours_end = ?');
      params.push(patch.active_hours_end || null);
    }
    if (patch.active_hours_tz !== undefined) {
      sets.push('active_hours_tz = ?');
      params.push(patch.active_hours_tz || null);
    }
  }

  if (patch.nextRunAt !== undefined || patch.next_run_at !== undefined) {
    sets.push('next_run_at = ?');
    params.push(patch.nextRunAt ?? patch.next_run_at ?? null);
  }
  if (patch.lastHash !== undefined || patch.last_heartbeat_hash !== undefined) {
    sets.push('last_heartbeat_hash = ?');
    params.push((patch.lastHash ?? patch.last_heartbeat_hash) || null);
  }
  if (patch.lastSentAt !== undefined || patch.last_heartbeat_sent_at !== undefined) {
    sets.push('last_heartbeat_sent_at = ?');
    params.push(patch.lastSentAt ?? patch.last_heartbeat_sent_at ?? null);
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(1);

  run(`UPDATE heartbeat_config SET ${sets.join(', ')} WHERE id = ?`, params);
  flush();
  return getHeartbeatConfig();
}

export function addCronSkill(skill) {
  const now = Date.now();
  const id = skill.id || _genId('skill');
  run(
    `INSERT INTO cron_skills
     (id, name, allowed_tools, system_prompt, model, max_turns, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      skill.name,
      skill.allowedTools == null ? null : JSON.stringify(skill.allowedTools),
      skill.systemPrompt || null,
      skill.model || null,
      Number(skill.maxTurns ?? 3),
      Number(skill.timeoutMs ?? 60000),
      now,
      now,
    ]
  );
  flush();
  return _toCronSkillRecord(queryOne('SELECT * FROM cron_skills WHERE id = ?', [id]));
}

export function updateCronSkill(id, patch = {}) {
  const sets = [];
  const params = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.allowedTools !== undefined || patch.allowed_tools !== undefined) {
    const value = patch.allowedTools ?? patch.allowed_tools;
    sets.push('allowed_tools = ?');
    params.push(value == null ? null : JSON.stringify(value));
  }
  if (patch.systemPrompt !== undefined || patch.system_prompt !== undefined) {
    sets.push('system_prompt = ?');
    params.push((patch.systemPrompt ?? patch.system_prompt) || null);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model || null);
  }
  if (patch.maxTurns !== undefined || patch.max_turns !== undefined) {
    sets.push('max_turns = ?');
    params.push(Number(patch.maxTurns ?? patch.max_turns ?? 3));
  }
  if (patch.timeoutMs !== undefined || patch.timeout_ms !== undefined) {
    sets.push('timeout_ms = ?');
    params.push(Number(patch.timeoutMs ?? patch.timeout_ms ?? 60000));
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  run(`UPDATE cron_skills SET ${sets.join(', ')} WHERE id = ?`, params);
  flush();
}

export function removeCronSkill(id) {
  run('DELETE FROM cron_skills WHERE id = ?', [id]);
  flush();
}

export function listCronSkills() {
  return query('SELECT * FROM cron_skills ORDER BY updated_at DESC').map(_toCronSkillRecord);
}

export function addCronJob(job) {
  const now = Date.now();
  const id = job.id || _genId('job');
  const schedule = job.schedule || {};
  const activeHours = job.activeHours || {};
  const nextRunAt = job.nextRunAt ?? _resolveNextRunAt(schedule, now);
  run(
    `INSERT INTO cron_jobs
     (id, name, enabled, session_target, wake_mode, schedule_kind, schedule_every_ms, schedule_anchor_ms, schedule_at_ms,
      skill_id, prompt, delivery_mode, delivery_webhook_url, delivery_notification_title,
      active_hours_start, active_hours_end, active_hours_tz,
      last_run_at, next_run_at, last_run_status, last_error, last_duration_ms,
      last_response_hash, last_response_sent_at, consecutive_errors, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      job.name,
      _toIntBool(job.enabled !== false),
      job.sessionTarget || 'isolated',
      job.wakeMode || 'next-heartbeat',
      schedule.kind,
      schedule.kind === 'every' ? Number(schedule.everyMs) || null : null,
      Number(schedule.anchorMs ?? job.scheduleAnchorMs) || null,
      schedule.kind === 'at' ? Number(schedule.atMs) || null : null,
      job.skillId,
      job.prompt,
      job.deliveryMode || 'notification',
      job.deliveryWebhookUrl || null,
      job.deliveryNotificationTitle || null,
      activeHours.start || null,
      activeHours.end || null,
      activeHours.tz || activeHours.timezone || null,
      job.lastRunAt || null,
      nextRunAt,
      job.lastRunStatus || null,
      job.lastError || null,
      job.lastDurationMs || null,
      job.lastResponseHash || null,
      job.lastResponseSentAt || null,
      Number(job.consecutiveErrors || 0),
      now,
      now,
    ]
  );
  flush();
  return _toCronJobRecord(queryOne('SELECT * FROM cron_jobs WHERE id = ?', [id]));
}

export function updateCronJob(id, patch = {}) {
  const sets = [];
  const params = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(_toIntBool(!!patch.enabled));
  }
  if (patch.sessionTarget !== undefined || patch.session_target !== undefined) {
    sets.push('session_target = ?');
    params.push((patch.sessionTarget ?? patch.session_target) || 'isolated');
  }
  if (patch.wakeMode !== undefined || patch.wake_mode !== undefined) {
    sets.push('wake_mode = ?');
    params.push((patch.wakeMode ?? patch.wake_mode) || 'next-heartbeat');
  }

  if (patch.schedule) {
    const schedule = patch.schedule;
    if (schedule.kind !== undefined) {
      sets.push('schedule_kind = ?');
      params.push(schedule.kind);
    }
    if (schedule.everyMs !== undefined || schedule.every_ms !== undefined) {
      sets.push('schedule_every_ms = ?');
      params.push(Number(schedule.everyMs ?? schedule.every_ms) || null);
    }
    if (schedule.anchorMs !== undefined || schedule.anchor_ms !== undefined) {
      sets.push('schedule_anchor_ms = ?');
      params.push(Number(schedule.anchorMs ?? schedule.anchor_ms) || null);
    }
    if (schedule.atMs !== undefined || schedule.at_ms !== undefined) {
      sets.push('schedule_at_ms = ?');
      params.push(Number(schedule.atMs ?? schedule.at_ms) || null);
    }
    if (patch.nextRunAt === undefined && patch.next_run_at === undefined) {
      sets.push('next_run_at = ?');
      params.push(_resolveNextRunAt(schedule, Date.now()));
    }
  } else {
    if (patch.scheduleKind !== undefined || patch.schedule_kind !== undefined) {
      sets.push('schedule_kind = ?');
      params.push(patch.scheduleKind ?? patch.schedule_kind);
    }
    if (patch.scheduleEveryMs !== undefined || patch.schedule_every_ms !== undefined) {
      sets.push('schedule_every_ms = ?');
      params.push(Number(patch.scheduleEveryMs ?? patch.schedule_every_ms) || null);
    }
    if (patch.scheduleAnchorMs !== undefined || patch.schedule_anchor_ms !== undefined) {
      sets.push('schedule_anchor_ms = ?');
      params.push(Number(patch.scheduleAnchorMs ?? patch.schedule_anchor_ms) || null);
    }
    if (patch.scheduleAtMs !== undefined || patch.schedule_at_ms !== undefined) {
      sets.push('schedule_at_ms = ?');
      params.push(Number(patch.scheduleAtMs ?? patch.schedule_at_ms) || null);
    }
  }

  if (patch.skillId !== undefined || patch.skill_id !== undefined) {
    sets.push('skill_id = ?');
    params.push((patch.skillId ?? patch.skill_id) || null);
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?');
    params.push(patch.prompt || '');
  }
  if (patch.deliveryMode !== undefined || patch.delivery_mode !== undefined) {
    sets.push('delivery_mode = ?');
    params.push((patch.deliveryMode ?? patch.delivery_mode) || 'notification');
  }
  if (patch.deliveryWebhookUrl !== undefined || patch.delivery_webhook_url !== undefined) {
    sets.push('delivery_webhook_url = ?');
    params.push((patch.deliveryWebhookUrl ?? patch.delivery_webhook_url) || null);
  }
  if (
    patch.deliveryNotificationTitle !== undefined ||
    patch.delivery_notification_title !== undefined
  ) {
    sets.push('delivery_notification_title = ?');
    params.push((patch.deliveryNotificationTitle ?? patch.delivery_notification_title) || null);
  }

  const activeHours = patch.activeHours || patch.active_hours;
  if (activeHours) {
    sets.push('active_hours_start = ?');
    params.push(activeHours.start || null);
    sets.push('active_hours_end = ?');
    params.push(activeHours.end || null);
    sets.push('active_hours_tz = ?');
    params.push(activeHours.tz || activeHours.timezone || null);
  } else {
    if (patch.active_hours_start !== undefined) {
      sets.push('active_hours_start = ?');
      params.push(patch.active_hours_start || null);
    }
    if (patch.active_hours_end !== undefined) {
      sets.push('active_hours_end = ?');
      params.push(patch.active_hours_end || null);
    }
    if (patch.active_hours_tz !== undefined) {
      sets.push('active_hours_tz = ?');
      params.push(patch.active_hours_tz || null);
    }
  }

  if (patch.lastRunAt !== undefined || patch.last_run_at !== undefined) {
    sets.push('last_run_at = ?');
    params.push(patch.lastRunAt ?? patch.last_run_at ?? null);
  }
  if (patch.nextRunAt !== undefined || patch.next_run_at !== undefined) {
    sets.push('next_run_at = ?');
    params.push(patch.nextRunAt ?? patch.next_run_at ?? null);
  }
  if (patch.lastRunStatus !== undefined || patch.last_run_status !== undefined) {
    sets.push('last_run_status = ?');
    params.push((patch.lastRunStatus ?? patch.last_run_status) || null);
  }
  if (patch.lastError !== undefined || patch.last_error !== undefined) {
    sets.push('last_error = ?');
    params.push((patch.lastError ?? patch.last_error) || null);
  }
  if (patch.lastDurationMs !== undefined || patch.last_duration_ms !== undefined) {
    sets.push('last_duration_ms = ?');
    params.push(patch.lastDurationMs ?? patch.last_duration_ms ?? null);
  }
  if (patch.lastResponseHash !== undefined || patch.last_response_hash !== undefined) {
    sets.push('last_response_hash = ?');
    params.push((patch.lastResponseHash ?? patch.last_response_hash) || null);
  }
  if (patch.lastResponseSentAt !== undefined || patch.last_response_sent_at !== undefined) {
    sets.push('last_response_sent_at = ?');
    params.push(patch.lastResponseSentAt ?? patch.last_response_sent_at ?? null);
  }
  if (patch.consecutiveErrors !== undefined || patch.consecutive_errors !== undefined) {
    sets.push('consecutive_errors = ?');
    params.push(Number(patch.consecutiveErrors ?? patch.consecutive_errors) || 0);
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  run(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
  flush();
}

export function removeCronJob(id) {
  run('DELETE FROM cron_jobs WHERE id = ?', [id]);
  run('DELETE FROM cron_runs WHERE job_id = ?', [id]);
  flush();
}

export function listCronJobs() {
  return query('SELECT * FROM cron_jobs ORDER BY updated_at DESC').map(_toCronJobRecord);
}

export function getDueJobs(nowMs = Date.now()) {
  return query(
    `SELECT * FROM cron_jobs
     WHERE enabled = 1
       AND next_run_at IS NOT NULL
       AND next_run_at <= ?
     ORDER BY next_run_at ASC`,
    [nowMs]
  ).map(_toCronJobRecord);
}

export function insertCronRun(runData) {
  run(
    `INSERT INTO cron_runs
     (job_id, started_at, ended_at, status, duration_ms, error, response_text, was_heartbeat_ok, was_deduped, delivered, wake_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runData.jobId,
      runData.startedAt,
      runData.endedAt || null,
      runData.status || null,
      runData.durationMs || null,
      runData.error || null,
      runData.responseText || null,
      _toIntBool(!!runData.wasHeartbeatOk),
      _toIntBool(!!runData.wasDeduped),
      _toIntBool(!!runData.delivered),
      runData.wakeSource || null,
    ]
  );
  const row = queryOne('SELECT last_insert_rowid() as id');
  flush();
  return row?.id || null;
}

export function listCronRuns(jobId = null, limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  if (jobId) {
    return query(
      'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
      [jobId, safeLimit]
    ).map(_toCronRunRecord);
  }
  return query(
    'SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?',
    [safeLimit]
  ).map(_toCronRunRecord);
}

export function enqueueSystemEvent(sessionKey, contextKey, text) {
  const createdAt = Date.now();
  run(
    `INSERT INTO system_events
     (session_key, context_key, text, created_at, consumed)
     VALUES (?, ?, ?, ?, 0)`,
    [sessionKey, contextKey || null, text, createdAt]
  );
  flush();
}

export function peekPendingEvents(sessionKey) {
  return query(
    `SELECT id, session_key, context_key, text, created_at, consumed
     FROM system_events
     WHERE session_key = ? AND consumed = 0
     ORDER BY created_at ASC, id ASC`,
    [sessionKey]
  ).map((row) => ({
    id: row.id,
    sessionKey: row.session_key,
    contextKey: row.context_key || undefined,
    text: row.text,
    createdAt: row.created_at,
    consumed: _toBool(row.consumed),
  }));
}

export function consumePendingEvents(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  run(`UPDATE system_events SET consumed = 1 WHERE id IN (${placeholders})`, ids);
  flush();
}
