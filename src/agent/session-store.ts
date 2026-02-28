/**
 * SessionStore — Direct SQLite session persistence from the WebView.
 *
 * Accesses the same `mobile-claw` database used by DbBridgeHandler,
 * eliminating the worker→bridge→WebView→SQLite round-trip for session
 * save/load operations.
 *
 * Uses @capacitor-community/sqlite directly (same as DbBridgeHandler).
 */

import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

const DB_NAME = 'mobile-claw'

export class SessionStore {
  private sqlite: SQLiteConnection | null = null
  private db: any = null
  private initPromise: Promise<void> | null = null

  /**
   * Ensure the DB connection is open. Idempotent — safe to call multiple times.
   * Reuses the existing connection created by DbBridgeHandler.
   */
  async ensureReady(): Promise<void> {
    if (this.db) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = this._init()
    await this.initPromise
  }

  private async _init(): Promise<void> {
    this.sqlite = new SQLiteConnection(CapacitorSQLite)

    const isWeb = Capacitor.getPlatform() === 'web'
    if (isWeb) {
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
      // DbBridgeHandler should have already created the connection.
      // If not, create one (migrations are handled by DbBridgeHandler).
      this.db = await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', 2, false)
    }

    await this.db.open()
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  async saveSession(params: {
    sessionKey: string
    agentId: string
    messages: any[]
    model?: string
    startTime: number
  }): Promise<void> {
    await this.ensureReady()
    const now = Date.now()

    // Compute usage totals
    let inputTokens = 0
    let outputTokens = 0
    for (const msg of params.messages) {
      if (msg.role === 'assistant' && msg.usage) {
        inputTokens += msg.usage.input || 0
        outputTokens += msg.usage.output || 0
      }
    }
    const totalTokens = inputTokens + outputTokens

    // Upsert session row
    await this.db.run(
      `INSERT INTO sessions (session_key, agent_id, created_at, updated_at, model, total_tokens, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET
         updated_at = excluded.updated_at,
         model = excluded.model,
         total_tokens = excluded.total_tokens,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens`,
      [
        params.sessionKey,
        params.agentId,
        params.startTime,
        now,
        params.model || null,
        totalTokens,
        inputTokens,
        outputTokens,
      ],
      true,
    )

    // Insert messages (skip already-persisted ones)
    const existingResult = await this.db.query('SELECT COUNT(*) as cnt FROM messages WHERE session_key = ?', [
      params.sessionKey,
    ])
    const existingCount = existingResult.values?.[0]?.cnt || 0
    const newMessages = params.messages.slice(existingCount)

    if (newMessages.length > 0) {
      const stmts = newMessages.map((msg: any, i: number) => ({
        statement: `INSERT OR IGNORE INTO messages (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [
          params.sessionKey,
          existingCount + i,
          msg.role,
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          msg.timestamp || now,
          msg.model || params.model || null,
          msg.toolCallId || null,
          msg.usage?.input || null,
          msg.usage?.output || null,
        ],
      }))
      await this.db.executeSet(stmts, true)
    }
  }

  // ── Load ─────────────────────────────────────────────────────────────────

  async loadMessages(sessionKey: string): Promise<any[]> {
    await this.ensureReady()
    const result = await this.db.query(
      'SELECT role, content, timestamp, model, tool_call_id, usage_input, usage_output FROM messages WHERE session_key = ? ORDER BY sequence',
      [sessionKey],
    )
    return (result.values || []).map((r: any) => ({
      role: r.role,
      content: _parseJsonSafe(r.content),
      timestamp: r.timestamp,
      model: r.model,
      toolCallId: r.tool_call_id,
      usage: r.usage_input || r.usage_output ? { input: r.usage_input, output: r.usage_output } : undefined,
    }))
  }

  async listSessions(agentId = 'main'): Promise<any[]> {
    await this.ensureReady()
    const result = await this.db.query(
      'SELECT session_key, created_at, updated_at, model, total_tokens FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC',
      [agentId],
    )
    return (result.values || []).map((r: any) => ({
      sessionKey: r.session_key,
      sessionId: r.session_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      model: r.model,
      totalTokens: r.total_tokens,
    }))
  }

  async getLatestSession(agentId = 'main'): Promise<any | null> {
    await this.ensureReady()
    const result = await this.db.query(
      'SELECT session_key, created_at, updated_at, model, total_tokens FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1',
      [agentId],
    )
    const row = result.values?.[0]
    if (!row) return null
    return {
      sessionKey: row.session_key,
      sessionId: row.session_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: row.model,
      totalTokens: row.total_tokens,
    }
  }
}

function _parseJsonSafe(s: string): any {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
