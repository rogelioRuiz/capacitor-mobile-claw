import type { PluginListenerHandle } from '@capacitor/core'
import { registerPlugin } from '@capacitor/core'

interface HttpStreamPlugin {
  stream(options: {
    fetchId: string
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<void>
  abort(options: { fetchId: string }): Promise<void>
  addListener(eventName: 'httpStream', listener: (event: HttpStreamEvent) => void): Promise<PluginListenerHandle>
}

interface HttpStreamEvent {
  fetchId: string
  event: 'response' | 'chunk' | 'done' | 'error'
  status?: number
  statusText?: string
  headers?: Record<string, string>
  data?: string
  error?: string
  url?: string
}

interface InflightRequest {
  fetchId: string
  controller: ReadableStreamDefaultController<Uint8Array> | null
  responseStarted: boolean
  responseResolve: (response: Response) => void
  responseReject: (error: Error) => void
  cleanup: () => void
}

const HttpStream = registerPlugin<HttpStreamPlugin>('HttpStream')
const inflight = new Map<string, InflightRequest>()
const PROXY_MARKER = '__mobileClawProxied'
let listenerReady: Promise<void> | null = null

type ProxiedFetch = typeof fetch & { __mobileClawProxied?: true }

function ensureListener(): Promise<void> {
  if (!listenerReady) {
    listenerReady = HttpStream.addListener('httpStream', (event) => {
      const entry = inflight.get(event.fetchId)
      if (!entry) {
        return
      }

      switch (event.event) {
        case 'response': {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              entry.controller = controller
            },
          })
          entry.responseStarted = true
          const response = new Response(stream, {
            status: event.status ?? 200,
            statusText: event.statusText ?? '',
            headers: new Headers(event.headers ?? {}),
          })
          try {
            Object.defineProperty(response, 'url', { value: event.url ?? '', configurable: true })
          } catch {
            // Some runtimes expose Response.url as a non-configurable getter.
          }
          entry.responseResolve(response)
          break
        }
        case 'chunk':
          if (event.data) {
            entry.controller?.enqueue(decodeBase64(event.data))
          }
          break
        case 'done':
          if (!entry.responseStarted) {
            rejectEntry(entry, new Error('Native stream closed before response metadata'))
            return
          }
          entry.controller?.close()
          cleanupEntry(event.fetchId)
          break
        case 'error':
          rejectEntry(entry, new Error(event.error || 'Native stream failed'))
          break
      }
    }).then(() => {})
  }

  return listenerReady
}

function cleanupEntry(fetchId: string): void {
  const entry = inflight.get(fetchId)
  if (!entry) {
    return
  }
  inflight.delete(fetchId)
  entry.cleanup()
}

function rejectEntry(entry: InflightRequest, error: Error): void {
  if (entry.responseStarted && entry.controller) {
    entry.controller.error(error)
  } else {
    entry.responseReject(error)
  }
  cleanupEntry(entry.fetchId)
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== 'function') {
    throw new Error('Base64 decoding is unavailable in this runtime')
  }
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i)
  }
  return bytes
}

function isLocalRequest(url: URL): boolean {
  const currentUrl = new URL(window.location.href)
  return (
    url.origin === currentUrl.origin ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  )
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function createFetchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createProxiedFetch(): typeof fetch {
  const currentFetch = window.fetch as ProxiedFetch
  if (currentFetch[PROXY_MARKER]) {
    return currentFetch
  }

  const originalFetch = currentFetch.bind(window)

  const proxiedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url, window.location.href)

    if (isLocalRequest(url)) {
      return originalFetch(request)
    }

    await ensureListener()

    if (request.signal.aborted) {
      throw createAbortError()
    }

    const fetchId = createFetchId()
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()

    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        const entry = inflight.get(fetchId)
        if (!entry) {
          return
        }

        const abortError = createAbortError()
        if (entry.controller) {
          entry.controller.error(abortError)
        } else {
          entry.responseReject(abortError)
        }
        cleanupEntry(fetchId)
        void HttpStream.abort({ fetchId }).catch(() => {})
      }

      inflight.set(fetchId, {
        fetchId,
        controller: null,
        responseStarted: false,
        responseResolve: resolve,
        responseReject: reject,
        cleanup: () => request.signal.removeEventListener('abort', abort),
      })

      request.signal.addEventListener('abort', abort, { once: true })

      void HttpStream.stream({
        fetchId,
        url: url.href,
        method: request.method.toUpperCase(),
        headers,
        body,
      }).catch((error: unknown) => {
        const entry = inflight.get(fetchId)
        if (!entry) {
          return
        }

        rejectEntry(entry, error instanceof Error ? error : new Error(String(error)))
      })
    })
  }) as ProxiedFetch

  proxiedFetch[PROXY_MARKER] = true
  return proxiedFetch
}
