/**
 * ToolProxy — Optimistic worker tool bridge.
 *
 * Wraps each Node.js-dependent tool (file I/O, git, VM) as an AgentTool
 * whose execute() sends a `tool.execute` message to the worker and awaits
 * `tool.execute.result`.
 *
 * Uses optimistic enqueue: tool calls are queued immediately. If the worker
 * isn't ready yet, they sit in a pending queue and flush automatically when
 * `worker.ready` arrives. The Capacitor-NodeJS bridge rejects send() before
 * ready, so we manage our own queue.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { TOOL_SCHEMAS } from './tool-schemas'

const WORKER_BOOT_TIMEOUT_MS = 30_000

interface PendingCall {
  msg: { type: 'tool.execute'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  resolve: (result: AgentToolResult<unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ToolProxy {
  private workerReady = false
  private pendingQueue: PendingCall[] = []
  private inflightCalls = new Map<
    string,
    { resolve: (r: AgentToolResult<unknown>) => void; reject: (e: Error) => void }
  >()
  private sendFn: ((msg: Record<string, unknown>) => Promise<void>) | null = null

  /**
   * Set the bridge send function. Called by MobileClawEngine once the
   * nodePlugin is available (which happens before the worker is ready).
   */
  setBridge(sendFn: (msg: Record<string, unknown>) => Promise<void>): void {
    this.sendFn = sendFn
  }

  /**
   * Called when `worker.ready` is received. Flushes the pending queue.
   */
  setWorkerReady(): void {
    this.workerReady = true
    this._flushQueue()
  }

  /**
   * Handle a `tool.execute.result` message from the worker.
   */
  handleResult(msg: { toolCallId: string; toolName: string; result?: unknown; error?: string }): void {
    const entry = this.inflightCalls.get(msg.toolCallId)
    if (!entry) return
    this.inflightCalls.delete(msg.toolCallId)

    if (msg.error) {
      entry.resolve({
        content: [{ type: 'text', text: `Error executing ${msg.toolName}: ${msg.error}` }],
        details: { error: msg.error },
      })
    } else {
      // Worker returns the raw tool result — normalize to AgentToolResult format
      const raw = msg.result as any
      if (raw && Array.isArray(raw.content)) {
        entry.resolve(raw as AgentToolResult<unknown>)
      } else {
        entry.resolve({
          content: [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }],
          details: raw,
        })
      }
    }
  }

  /**
   * Build AgentTool[] from the shared schemas. Each tool's execute()
   * proxies to the worker via the bridge.
   */
  buildTools(): AgentTool<any>[] {
    return TOOL_SCHEMAS.map((schema) => ({
      name: schema.name,
      label: schema.label,
      description: schema.description,
      parameters: schema.parameters,
      execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        return this._executeViaWorker(schema.name, toolCallId, params, signal)
      },
    }))
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _executeViaWorker(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    return new Promise((resolve, reject) => {
      const msg = { type: 'tool.execute' as const, toolCallId, toolName, args }

      // Abort signal support
      if (signal?.aborted) {
        resolve({
          content: [{ type: 'text', text: `Tool "${toolName}" was aborted.` }],
          details: { aborted: true },
        })
        return
      }

      const onAbort = () => {
        this.inflightCalls.delete(toolCallId)
        // Remove from pending queue if still there
        const idx = this.pendingQueue.findIndex((p) => p.msg.toolCallId === toolCallId)
        if (idx !== -1) {
          clearTimeout(this.pendingQueue[idx].timer)
          this.pendingQueue.splice(idx, 1)
        }
        resolve({
          content: [{ type: 'text', text: `Tool "${toolName}" was aborted.` }],
          details: { aborted: true },
        })
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      // Boot timeout: if the worker doesn't come up within 30s, fail
      const timer = setTimeout(() => {
        if (!this.workerReady) {
          const idx = this.pendingQueue.findIndex((p) => p.msg.toolCallId === toolCallId)
          if (idx !== -1) this.pendingQueue.splice(idx, 1)
          signal?.removeEventListener('abort', onAbort)
          resolve({
            content: [
              {
                type: 'text',
                text: `Tool "${toolName}" timed out waiting for worker to start (${WORKER_BOOT_TIMEOUT_MS}ms).`,
              },
            ],
            details: { timeout: true },
          })
        }
      }, WORKER_BOOT_TIMEOUT_MS)

      if (this.workerReady && this.sendFn) {
        clearTimeout(timer)
        this.inflightCalls.set(toolCallId, { resolve, reject })
        this.sendFn(msg).catch((err) => {
          this.inflightCalls.delete(toolCallId)
          signal?.removeEventListener('abort', onAbort)
          resolve({
            content: [{ type: 'text', text: `Failed to send tool call to worker: ${err.message}` }],
            details: { sendError: err.message },
          })
        })
      } else {
        // Queue for later
        this.pendingQueue.push({ msg, resolve, reject, timer })
      }
    })
  }

  private _flushQueue(): void {
    if (!this.sendFn) return
    const queue = this.pendingQueue.splice(0)
    for (const entry of queue) {
      clearTimeout(entry.timer)
      this.inflightCalls.set(entry.msg.toolCallId, { resolve: entry.resolve, reject: entry.reject })
      this.sendFn(entry.msg).catch((err) => {
        this.inflightCalls.delete(entry.msg.toolCallId)
        entry.resolve({
          content: [{ type: 'text', text: `Failed to send queued tool call to worker: ${err.message}` }],
          details: { sendError: err.message },
        })
      })
    }
  }
}
