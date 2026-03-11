import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock @capacitor/core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
}))

// In-memory filesystem mock
const _files: Record<string, string> = {}

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Library: 'LIBRARY' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: vi.fn(async ({ path }: { path: string }) => {
      if (_files[path]) return { data: _files[path] }
      throw new Error('File not found')
    }),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      _files[path] = data
    }),
  },
}))

import { deleteAuth, getAuthStatus, getAuthToken, setAuthKey, setAuthRoot } from '../../src/agent/auth-store'

describe('auth-store', () => {
  afterEach(() => {
    // Reset filesystem
    for (const key of Object.keys(_files)) delete _files[key]
    vi.clearAllMocks()
  })

  describe('getAuthToken', () => {
    it('returns null when no profiles exist', async () => {
      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBeNull()
      expect(result.isOAuth).toBe(false)
    })

    it('returns API key when set', async () => {
      await setAuthKey('sk-ant-api01-test', 'anthropic', 'main', 'api_key')
      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBe('sk-ant-api01-test')
      expect(result.isOAuth).toBe(false)
    })

    it('returns OAuth token and detects isOAuth', async () => {
      await setAuthKey('sk-ant-oat01-test-token', 'anthropic', 'main', 'oauth')
      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBe('sk-ant-oat01-test-token')
      expect(result.isOAuth).toBe(true)
    })

    it('prefers OAuth over API key for same provider', async () => {
      await setAuthKey('sk-ant-api01-apikey', 'anthropic', 'main', 'api_key')
      await setAuthKey('sk-ant-oat01-oauth', 'anthropic', 'main', 'oauth')
      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBe('sk-ant-oat01-oauth')
      expect(result.isOAuth).toBe(true)
    })

    it('uses lastGood profile when available', async () => {
      await setAuthKey('sk-ant-oat01-good', 'anthropic', 'main', 'oauth')
      // lastGood was set to 'anthropic-oauth' by setAuthKey
      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBe('sk-ant-oat01-good')
    })

    it('returns correct provider key (not cross-provider)', async () => {
      await setAuthKey('sk-ant-oat01-anthropic', 'anthropic', 'main', 'oauth')
      await setAuthKey('sk-or-openrouter-key', 'openrouter', 'main', 'api_key')

      const anthropic = await getAuthToken('anthropic', 'main')
      expect(anthropic.apiKey).toBe('sk-ant-oat01-anthropic')

      const openrouter = await getAuthToken('openrouter', 'main')
      expect(openrouter.apiKey).toBe('sk-or-openrouter-key')
    })
  })

  describe('setAuthKey', () => {
    it('creates profile file when none exists', async () => {
      await setAuthKey('test-key', 'anthropic', 'main', 'api_key')
      const path = 'nodejs/data/agents/main/agent/auth-profiles.json'
      expect(_files[path]).toBeDefined()
      const parsed = JSON.parse(_files[path])
      expect(parsed.profiles['anthropic-api_key']).toEqual({
        provider: 'anthropic',
        type: 'api_key',
        key: 'test-key',
      })
      expect(parsed.lastGood.anthropic).toBe('anthropic-api_key')
    })

    it('stores OAuth token with access field', async () => {
      await setAuthKey('sk-ant-oat01-token', 'anthropic', 'main', 'oauth')
      const path = 'nodejs/data/agents/main/agent/auth-profiles.json'
      const parsed = JSON.parse(_files[path])
      expect(parsed.profiles['anthropic-oauth']).toEqual({
        provider: 'anthropic',
        type: 'oauth',
        access: 'sk-ant-oat01-token',
      })
    })

    it('preserves existing profiles when adding new one', async () => {
      await setAuthKey('key-a', 'anthropic', 'main', 'api_key')
      await setAuthKey('key-b', 'openrouter', 'main', 'api_key')
      const path = 'nodejs/data/agents/main/agent/auth-profiles.json'
      const parsed = JSON.parse(_files[path])
      expect(parsed.profiles['anthropic-api_key']).toBeDefined()
      expect(parsed.profiles['openrouter-api_key']).toBeDefined()
    })
  })

  describe('deleteAuth', () => {
    it('removes all profiles for a provider', async () => {
      await setAuthKey('key-api', 'anthropic', 'main', 'api_key')
      await setAuthKey('key-oauth', 'anthropic', 'main', 'oauth')
      await deleteAuth('anthropic', 'main')

      const result = await getAuthToken('anthropic', 'main')
      expect(result.apiKey).toBeNull()
    })

    it('does not affect other providers', async () => {
      await setAuthKey('key-ant', 'anthropic', 'main', 'api_key')
      await setAuthKey('key-or', 'openrouter', 'main', 'api_key')
      await deleteAuth('anthropic', 'main')

      const or = await getAuthToken('openrouter', 'main')
      expect(or.apiKey).toBe('key-or')
    })

    it('handles delete when no profiles exist', async () => {
      // Should not throw
      await deleteAuth('anthropic', 'main')
    })
  })

  describe('getAuthStatus', () => {
    it('returns hasKey=false when no key exists', async () => {
      const status = await getAuthStatus('anthropic')
      expect(status.hasKey).toBe(false)
      expect(status.masked).toBe('')
      expect(status.provider).toBe('anthropic')
    })

    it('returns masked key when key exists', async () => {
      await setAuthKey('sk-ant-api01-verylongkey', 'anthropic', 'main', 'api_key')
      const status = await getAuthStatus('anthropic')
      expect(status.hasKey).toBe(true)
      // Mask: first 7 chars + *** + last 4 chars
      expect(status.masked).toBe('sk-ant-***gkey')
      expect(status.provider).toBe('anthropic')
    })

    it('masks short keys with ***', async () => {
      await setAuthKey('short', 'anthropic', 'main', 'api_key')
      const status = await getAuthStatus('anthropic')
      expect(status.hasKey).toBe(true)
      expect(status.masked).toBe('***')
    })
  })

  describe('setAuthRoot', () => {
    it('changes the root path for auth profiles', async () => {
      setAuthRoot('custom/root')
      await setAuthKey('test-key', 'anthropic', 'main', 'api_key')
      const path = 'custom/root/agents/main/agent/auth-profiles.json'
      expect(_files[path]).toBeDefined()
      // Reset to default for other tests
      setAuthRoot('nodejs/data')
    })
  })
})
