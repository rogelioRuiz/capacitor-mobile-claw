/**
 * STOMP-based MCP Server Transport
 *
 * Bridges WebSocket STOMP to the MCP SDK Transport interface, using a
 * requestContextMap pattern for correlating JSON-RPC request/response pairs.
 *
 * Each incoming STOMP frame carries a JSON-RPC message with reply-to / correlation-id
 * headers. The transport stores these in a map keyed by the JSON-RPC message id, then
 * routes the MCP server's response back to the correct reply-to destination.
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { type IFrame, type IMessage, Client as StompClient } from '@stomp/stompjs'

interface RequestContext {
  replyTo: string
  correlationId: string
}

export interface StompTransportConfig {
  /** WebSocket STOMP broker URL, e.g. wss://your-broker.example.com/ws */
  brokerURL: string
  /** RabbitMQ username */
  login: string
  /** RabbitMQ password */
  passcode: string
  /** Unique device identifier — determines the request queue name */
  deviceId: string
  /** Reconnection delay in ms (default 5000) */
  reconnectDelay?: number
}

export class StompServerTransport implements Transport {
  // Transport interface callbacks
  public onmessage?: <T extends JSONRPCMessage>(message: T) => void
  public onclose?: () => void
  public onerror?: (error: Error) => void
  public sessionId?: string

  private stompClient: StompClient
  private requestContextMap = new Map<string | number, RequestContext>()
  private requestQueue: string
  private _started = false

  constructor(private config: StompTransportConfig) {
    this.requestQueue = `/queue/mcp.device.${config.deviceId}.requests`

    this.stompClient = new StompClient({
      brokerURL: config.brokerURL,
      connectHeaders: {
        login: config.login,
        passcode: config.passcode,
      },
      reconnectDelay: config.reconnectDelay ?? 5000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
    })
  }

  async start(): Promise<void> {
    if (this._started) return

    return new Promise<void>((resolve, reject) => {
      this.stompClient.onConnect = () => {
        console.log('[MCP-STOMP] Connected to broker')

        // Subscribe to device-specific request queue
        // auto-delete queue: disappears when consumer disconnects
        this.stompClient.subscribe(this.requestQueue, (frame: IMessage) => this.handleIncomingMessage(frame), {
          'auto-delete': 'true',
          'x-expires': '3600000', // auto-delete after 1h of no consumers
        })

        console.log(`[MCP-STOMP] Subscribed to ${this.requestQueue}`)
        this._started = true
        resolve()
      }

      this.stompClient.onStompError = (frame: IFrame) => {
        const msg = frame.headers.message || 'STOMP error'
        const error = new Error(`[MCP-STOMP] ${msg}`)
        console.error(error.message, frame.body)
        this.onerror?.(error)
        if (!this._started) reject(error)
      }

      this.stompClient.onWebSocketClose = () => {
        console.log('[MCP-STOMP] WebSocket closed')
        // Don't invoke onclose here — stompjs reconnect will handle it
        // onclose is invoked only on explicit close()
      }

      this.stompClient.onDisconnect = () => {
        console.log('[MCP-STOMP] Disconnected')
      }

      this.stompClient.activate()
    })
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const messageId = (message as any).id
    const context = messageId !== undefined ? this.requestContextMap.get(messageId) : undefined

    if (context) {
      const { replyTo, correlationId } = context

      this.stompClient.publish({
        destination: replyTo,
        headers: { 'correlation-id': correlationId, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })

      console.log(`[MCP-STOMP] Sent response to ${replyTo} (correlation: ${correlationId})`)
      this.requestContextMap.delete(messageId)
    } else {
      // Notifications (no id) — broadcast to a notification destination if needed
      console.warn('[MCP-STOMP] No reply destination for message', message)
    }
  }

  async close(): Promise<void> {
    this._started = false
    this.requestContextMap.clear()
    await this.stompClient.deactivate()
    this.onclose?.()
  }

  get connected(): boolean {
    return this.stompClient.connected
  }

  get deviceId(): string {
    return this.config.deviceId
  }

  private handleIncomingMessage(frame: IMessage): void {
    try {
      const jsonRpcMessage = JSON.parse(frame.body)

      // Extract routing info from STOMP headers
      const replyTo = frame.headers['reply-to']
      const correlationId = frame.headers['correlation-id'] || frame.headers['message-id'] || ''

      // Store context for response routing (mirrors requestContextMap from amqp.service.ts)
      if (replyTo && jsonRpcMessage.id !== undefined) {
        this.requestContextMap.set(jsonRpcMessage.id, { replyTo, correlationId })
      }

      // Strip non-standard headers field before passing to MCP server
      const cleanMessage = { ...jsonRpcMessage }
      if ('headers' in cleanMessage) {
        delete cleanMessage.headers
      }

      console.log(`[MCP-STOMP] Received ${cleanMessage.method || 'response'} (id: ${cleanMessage.id})`)

      // Dispatch to MCP server
      this.onmessage?.(cleanMessage as JSONRPCMessage)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[MCP-STOMP] Error processing message:', err.message)
      this.onerror?.(err)
    }
  }
}
