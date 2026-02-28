import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HttpStreamEvent = {
  fetchId: string
  event: 'response' | 'chunk' | 'done' | 'error'
  status?: number
  statusText?: string
  headers?: Record<string, string>
  data?: string
  error?: string
  url?: string
}

let mockHttpStream: {
  addListener: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

const registerPluginMock = vi.fn(() => mockHttpStream)

vi.mock('@capacitor/core', () => ({
  registerPlugin: registerPluginMock,
}))

describe('createProxiedFetch', () => {
  const originalWindow = (globalThis as Record<string, unknown>).window

  beforeEach(() => {
    vi.resetModules()
    registerPluginMock.mockClear()

    let listener: ((event: HttpStreamEvent) => void) | null = null
    mockHttpStream = {
      addListener: vi.fn(async (_eventName: string, callback: (event: HttpStreamEvent) => void) => {
        listener = callback
        return { remove: async () => {} }
      }),
      stream: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: { href: 'http://localhost/' },
        fetch: vi.fn(async () => new Response('local', { status: 200 })),
      },
    })

    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('fetch-1')

    ;(globalThis as Record<string, unknown>).__emitHttpStream = (event: HttpStreamEvent) => {
      listener?.(event)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      })
    }
    Reflect.deleteProperty(globalThis as Record<string, unknown>, '__emitHttpStream')
  })

  it('passes same-origin requests through to the original fetch', async () => {
    const { createProxiedFetch } = await import('../../src/agent/fetch-proxy')
    const proxiedFetch = createProxiedFetch()

    const response = await proxiedFetch('http://localhost/api/health')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('local')
    expect(window.fetch).toHaveBeenCalledTimes(1)
    expect(mockHttpStream.stream).not.toHaveBeenCalled()
  })

  it('streams external responses through a ReadableStream-backed Response', async () => {
    mockHttpStream.stream.mockImplementationOnce(async (options: { fetchId: string }) => {
      const emit = (globalThis as Record<string, any>).__emitHttpStream as (event: HttpStreamEvent) => void
      emit({
        fetchId: options.fetchId,
        event: 'response',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
        url: 'https://api.anthropic.com/v1/messages',
      })
      emit({ fetchId: options.fetchId, event: 'chunk', data: btoa('hel') })
      emit({ fetchId: options.fetchId, event: 'chunk', data: btoa('lo') })
      emit({ fetchId: options.fetchId, event: 'done' })
    })

    const { createProxiedFetch } = await import('../../src/agent/fetch-proxy')
    const proxiedFetch = createProxiedFetch()

    const response = await proxiedFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"stream":true}',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('hello')
    expect(mockHttpStream.addListener).toHaveBeenCalledTimes(1)
    expect(mockHttpStream.stream).toHaveBeenCalledWith({
      fetchId: 'fetch-1',
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":true}',
    })
  })
})
