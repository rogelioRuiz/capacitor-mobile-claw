import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../../src/agent/retry-logic'

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(async () => 'ok')
    expect(result).toBe('ok')
  })

  it('retries on 429 and succeeds', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) {
          const err: any = new Error('rate limited')
          err.status = 429
          throw err
        }
        return 'recovered'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('recovered')
    expect(attempt).toBe(2)
  })

  it('retries on 503 and succeeds', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) {
          const err: any = new Error('service unavailable')
          err.status = 503
          throw err
        }
        return 'recovered'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('recovered')
  })

  it('retries on 502 and succeeds', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) {
          const err: any = new Error('bad gateway')
          err.status = 502
          throw err
        }
        return 'recovered'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('recovered')
  })

  it('retries on "rate limit" message', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) throw new Error('rate limit exceeded')
        return 'ok'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('ok')
  })

  it('retries on "overloaded" message', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) throw new Error('server overloaded')
        return 'ok'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('ok')
  })

  it('retries on "timeout" message', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt === 1) throw new Error('request timeout')
        return 'ok'
      },
      { maxRetries: 2, baseDelayMs: 10 },
    )
    expect(result).toBe('ok')
  })

  it('does NOT retry non-retryable errors (400)', async () => {
    const err: any = new Error('bad request')
    err.status = 400
    await expect(
      withRetry(
        async () => {
          throw err
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('bad request')
  })

  it('does NOT retry non-retryable errors (401)', async () => {
    const err: any = new Error('unauthorized')
    err.status = 401
    await expect(
      withRetry(
        async () => {
          throw err
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('unauthorized')
  })

  it('does NOT retry generic errors', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('some bug')
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('some bug')
  })

  it('throws after exhausting all retries', async () => {
    let attempt = 0
    await expect(
      withRetry(
        async () => {
          attempt++
          const err: any = new Error('rate limited')
          err.status = 429
          throw err
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('rate limited')
    expect(attempt).toBe(3) // initial + 2 retries
  })

  it('calls onRetry callback with correct arguments', async () => {
    const onRetry = vi.fn()
    let attempt = 0
    await withRetry(
      async () => {
        attempt++
        if (attempt <= 2) {
          const err: any = new Error('overloaded')
          err.status = 503
          throw err
        }
        return 'ok'
      },
      { maxRetries: 3, baseDelayMs: 10 },
      onRetry,
    )
    expect(onRetry).toHaveBeenCalledTimes(2)
    // First retry: attempt=1
    expect(onRetry.mock.calls[0][0]).toBe(1)
    expect(typeof onRetry.mock.calls[0][1]).toBe('number') // jittered delay
    expect(onRetry.mock.calls[0][2]).toBeInstanceOf(Error)
    // Second retry: attempt=2
    expect(onRetry.mock.calls[1][0]).toBe(2)
  })

  it('uses default options when none provided', async () => {
    // Should not throw with defaults
    const result = await withRetry(async () => 42)
    expect(result).toBe(42)
  })

  it('respects maxDelayMs cap', async () => {
    const onRetry = vi.fn()
    let attempt = 0
    await withRetry(
      async () => {
        attempt++
        if (attempt === 1) {
          const err: any = new Error('overloaded')
          err.status = 503
          throw err
        }
        return 'ok'
      },
      { maxRetries: 1, baseDelayMs: 100000, maxDelayMs: 50 },
      onRetry,
    )
    // The delay should be capped at maxDelayMs (with jitter: 0.5*50 to 50)
    expect(onRetry.mock.calls[0][1]).toBeLessThanOrEqual(50)
    expect(onRetry.mock.calls[0][1]).toBeGreaterThanOrEqual(25)
  })
})
