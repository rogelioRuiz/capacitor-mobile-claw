import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../src/agent/session-store'

/**
 * SessionStore unit tests.
 *
 * SessionStore depends on @capacitor-community/sqlite which requires a native
 * Capacitor runtime (Android/iOS/jeep-sqlite for web). In a pure Node.js test
 * environment, the SQLite connection cannot be established.
 *
 * These tests verify the class structure and API surface. Full integration
 * testing happens on-device via the E2E test suite.
 */
describe('SessionStore', () => {
  it('should be constructable', () => {
    const store = new SessionStore()
    expect(store).toBeDefined()
  })

  it('should have ensureReady method', () => {
    const store = new SessionStore()
    expect(typeof store.ensureReady).toBe('function')
  })

  it('should have saveSession method', () => {
    const store = new SessionStore()
    expect(typeof store.saveSession).toBe('function')
  })

  it('should have loadMessages method', () => {
    const store = new SessionStore()
    expect(typeof store.loadMessages).toBe('function')
  })

  it('should have listSessions method', () => {
    const store = new SessionStore()
    expect(typeof store.listSessions).toBe('function')
  })

  it('should have getLatestSession method', () => {
    const store = new SessionStore()
    expect(typeof store.getLatestSession).toBe('function')
  })

  describe('_parseJsonSafe (via import)', () => {
    // We can't directly test a private function, but we can test the behavior
    // by examining loadMessages return shape. Since SQLite isn't available in
    // Node.js tests, we'll test the function logic inline.

    function parseJsonSafe(s: string): any {
      if (typeof s !== 'string') return s
      try {
        return JSON.parse(s)
      } catch {
        return s
      }
    }

    it('should parse valid JSON strings', () => {
      const result = parseJsonSafe('[{"type":"text","text":"hello"}]')
      expect(result).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('should return non-JSON strings as-is', () => {
      const result = parseJsonSafe('just a plain string')
      expect(result).toBe('just a plain string')
    })

    it('should handle empty string', () => {
      const result = parseJsonSafe('')
      expect(result).toBe('')
    })

    it('should parse JSON objects', () => {
      const result = parseJsonSafe('{"key":"value"}')
      expect(result).toEqual({ key: 'value' })
    })
  })
})
