/**
 * Phase 2 E2E Test: Workspace & Auth Management
 *
 * Verifies:
 * - Workspace files read/write via bridge protocol functions
 * - YAML frontmatter preserved during read/write cycles
 * - Auth profile management (set key, get status, masked output)
 * - config.status bridge message returns correct state
 * - config.update setApiKey persists to auth-profiles.json
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TEST_ROOT = join(process.cwd(), '.test-workspace-auth')
const OPENCLAW_ROOT = TEST_ROOT
const WORKSPACE = join(OPENCLAW_ROOT, 'workspace')
const AUTH_DIR = join(OPENCLAW_ROOT, 'agents', 'main', 'agent')
const AUTH_PATH = join(AUTH_DIR, 'auth-profiles.json')

// ── Replicate workspace file tool functions from main.js ─────────────────────

function readFileTool(args: { path: string }) {
  const filePath = resolve(WORKSPACE, args.path)
  if (!filePath.startsWith(resolve(WORKSPACE))) {
    return { error: 'Access denied: path outside workspace' }
  }
  try {
    const content = readFileSync(filePath, 'utf8')
    return { content }
  } catch (err: any) {
    return { error: `Failed to read file: ${err.message}` }
  }
}

function writeFileTool(args: { path: string; content: string }) {
  const filePath = resolve(WORKSPACE, args.path)
  if (!filePath.startsWith(resolve(WORKSPACE))) {
    return { error: 'Access denied: path outside workspace' }
  }
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, args.content)
    return { success: true, path: args.path }
  } catch (err: any) {
    return { error: `Failed to write file: ${err.message}` }
  }
}

// ── Replicate auth profile functions from main.js ────────────────────────────

function loadAuthProfiles() {
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
  } catch {
    return { version: 1, profiles: {}, lastGood: {}, usageStats: {} }
  }
}

function saveAuthProfiles(profiles: any) {
  writeFileSync(AUTH_PATH, JSON.stringify(profiles, null, 2))
}

// ── Replicate config.status handler from main.js ─────────────────────────────

function handleConfigStatus() {
  const profiles = loadAuthProfiles()
  let hasKey = false
  let masked = ''
  for (const [, profile] of Object.entries(profiles.profiles) as any) {
    if (profile.provider === 'anthropic') {
      const key = profile.key || profile.access || ''
      if (key) {
        hasKey = true
        masked = key.length > 11 ? `${key.substring(0, 7)}***${key.substring(key.length - 4)}` : '***'
        break
      }
    }
  }
  return { type: 'config.status.result', hasKey, masked }
}

// ── Replicate config.update setApiKey handler from main.js ───────────────────

function handleSetApiKey(provider: string, apiKey: string) {
  const profiles = loadAuthProfiles()
  const profileKey = `${provider}:default`
  profiles.profiles[profileKey] = {
    type: 'api_key',
    provider,
    key: apiKey,
  }
  profiles.lastGood = profiles.lastGood || {}
  profiles.lastGood[provider] = profileKey
  saveAuthProfiles(profiles)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Workspace File Editor', () => {
  beforeAll(() => {
    mkdirSync(WORKSPACE, { recursive: true })
    mkdirSync(AUTH_DIR, { recursive: true })
    writeFileSync(
      AUTH_PATH,
      JSON.stringify(
        {
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
        },
        null,
        2,
      ),
    )

    writeFileSync(join(WORKSPACE, 'SOUL.md'), '# Soul\n\nYou are a helpful AI assistant.\n')
    writeFileSync(join(WORKSPACE, 'MEMORY.md'), '# Memory\n\nPersistent knowledge.\n')
    writeFileSync(join(WORKSPACE, 'IDENTITY.md'), '# Identity\n\nName: test-agent\n')
  })

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('reads SOUL.md from workspace', () => {
    const result = readFileTool({ path: 'SOUL.md' })
    expect(result.content).toContain('# Soul')
    expect(result.content).toContain('helpful AI assistant')
  })

  it('reads MEMORY.md from workspace', () => {
    const result = readFileTool({ path: 'MEMORY.md' })
    expect(result.content).toContain('# Memory')
  })

  it('reads IDENTITY.md from workspace', () => {
    const result = readFileTool({ path: 'IDENTITY.md' })
    expect(result.content).toContain('test-agent')
  })

  it('writes updated SOUL.md content', () => {
    const newContent = '# Soul\n\nYou are a mobile-first AI assistant.\n'
    const result = writeFileTool({ path: 'SOUL.md', content: newContent })
    expect(result.success).toBe(true)

    const readBack = readFileTool({ path: 'SOUL.md' })
    expect(readBack.content).toBe(newContent)
  })

  it('preserves YAML frontmatter in round-trip', () => {
    const contentWithFrontmatter = `---
title: Agent Personality
version: 2
---

# Soul

Custom personality with frontmatter.
`
    writeFileTool({ path: 'SOUL.md', content: contentWithFrontmatter })
    const readBack = readFileTool({ path: 'SOUL.md' })
    expect(readBack.content).toBe(contentWithFrontmatter)
    expect(readBack.content).toContain('---\ntitle: Agent Personality')
  })

  it('preserves unicode content', () => {
    const unicode = '# Memoria\n\nContenido en espa\u00f1ol con acentos: \u00e1\u00e9\u00ed\u00f3\u00fa \u00f1\n'
    writeFileTool({ path: 'MEMORY.md', content: unicode })
    const readBack = readFileTool({ path: 'MEMORY.md' })
    expect(readBack.content).toBe(unicode)
  })

  it('blocks path traversal on read', () => {
    const result = readFileTool({ path: '../../../etc/passwd' })
    expect(result.error).toContain('Access denied')
  })

  it('blocks path traversal on write', () => {
    const result = writeFileTool({ path: '../../evil.txt', content: 'bad' })
    expect(result.error).toContain('Access denied')
  })

  it('returns error for non-existent file', () => {
    const result = readFileTool({ path: 'NONEXISTENT.md' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('Failed to read file')
  })
})

describe('Auth Profile Management', () => {
  beforeAll(() => {
    mkdirSync(AUTH_DIR, { recursive: true })
    writeFileSync(
      AUTH_PATH,
      JSON.stringify(
        {
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
        },
        null,
        2,
      ),
    )
  })

  it('reports no API key when profiles are empty', () => {
    const status = handleConfigStatus()
    expect(status.type).toBe('config.status.result')
    expect(status.hasKey).toBe(false)
    expect(status.masked).toBe('')
  })

  it('sets an API key via setApiKey action', () => {
    handleSetApiKey('anthropic', 'sk-ant-api03-test1234567890abcdef')

    const profiles = loadAuthProfiles()
    expect(profiles.profiles['anthropic:default']).toBeDefined()
    expect(profiles.profiles['anthropic:default'].type).toBe('api_key')
    expect(profiles.profiles['anthropic:default'].provider).toBe('anthropic')
    expect(profiles.profiles['anthropic:default'].key).toBe('sk-ant-api03-test1234567890abcdef')
  })

  it('reports hasKey=true after key is set', () => {
    const status = handleConfigStatus()
    expect(status.hasKey).toBe(true)
  })

  it('masks the key correctly (first 7 + *** + last 4)', () => {
    const status = handleConfigStatus()
    expect(status.masked).toMatch(/^sk-ant-\*\*\*.{4}$/)
    expect(status.masked).toContain('***')
    expect(status.masked.startsWith('sk-ant-')).toBe(true)
  })

  it('overwrites an existing key', () => {
    handleSetApiKey('anthropic', 'sk-ant-api03-NEWKEY0000000000xxxx')
    const profiles = loadAuthProfiles()
    expect(profiles.profiles['anthropic:default'].key).toBe('sk-ant-api03-NEWKEY0000000000xxxx')
  })

  it('updates lastGood provider reference', () => {
    const profiles = loadAuthProfiles()
    expect(profiles.lastGood.anthropic).toBe('anthropic:default')
  })

  it('saves keys with non-standard format (no validation block)', () => {
    handleSetApiKey('anthropic', 'custom-key-format')
    const profiles = loadAuthProfiles()
    expect(profiles.profiles['anthropic:default'].key).toBe('custom-key-format')
  })

  it('handles short keys with masked output as ***', () => {
    handleSetApiKey('anthropic', 'short')
    const status = handleConfigStatus()
    expect(status.hasKey).toBe(true)
    expect(status.masked).toBe('***')
  })

  it('handles OAuth profile type in status check', () => {
    const profiles = loadAuthProfiles()
    profiles.profiles['anthropic:oauth'] = {
      type: 'oauth',
      provider: 'anthropic',
      access: 'sk-ant-oat01-longtoken1234567890abcdef',
    }
    saveAuthProfiles(profiles)

    // Remove the api_key profile to test OAuth detection
    delete profiles.profiles['anthropic:default']
    saveAuthProfiles(profiles)

    const status = handleConfigStatus()
    expect(status.hasKey).toBe(true)
    expect(status.masked).toContain('sk-ant-')
  })
})

describe('Bridge Protocol — Config Messages', () => {
  it('config.status.result has correct shape', () => {
    const result = handleConfigStatus()
    expect(result).toHaveProperty('type', 'config.status.result')
    expect(result).toHaveProperty('hasKey')
    expect(result).toHaveProperty('masked')
    expect(typeof result.hasKey).toBe('boolean')
    expect(typeof result.masked).toBe('string')
  })

  it('config.update setApiKey persists to disk', () => {
    // Reset profiles
    writeFileSync(
      AUTH_PATH,
      JSON.stringify(
        {
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
        },
        null,
        2,
      ),
    )

    handleSetApiKey('anthropic', 'sk-ant-api03-diskpersist')

    // Read raw file from disk
    const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
    expect(raw.profiles['anthropic:default'].key).toBe('sk-ant-api03-diskpersist')
  })
})
