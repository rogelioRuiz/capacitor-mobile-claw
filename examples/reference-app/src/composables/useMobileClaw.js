/**
 * useMobileClaw — Vue composable for the Mobile Claw reference app.
 *
 * Simplified wrapper around MobileClawEngine with:
 * - Auto-approve all tool requests (unrestricted mode)
 * - No MCP state management
 * - No backend/auth integration
 */

import { ref } from 'vue'
import { MobileClawEngine } from 'capacitor-mobile-claw'
import { isNative } from '@/lib/platform.js'

// ── Module-level singleton ───────────────────────────────────────────────

const engine = new MobileClawEngine()

const available = ref(false)
const workerReady = ref(false)
const nodeVersion = ref(null)
const openclawRoot = ref(null)
const loading = ref(false)
const error = ref(null)

let initPromise = null

// ── Init ─────────────────────────────────────────────────────────────────

async function init() {
  if (initPromise) return initPromise
  initPromise = _doInit()
  return initPromise
}

async function _doInit() {
  if (!isNative) {
    available.value = false
    return
  }

  loading.value = true
  error.value = null

  try {
    // Listen for worker.ready to keep reactive refs in sync
    engine.onMessage('worker.ready', () => {
      available.value = engine.available
      workerReady.value = engine.ready
      nodeVersion.value = engine.nodeVersion
      openclawRoot.value = engine.openclawRoot
      loading.value = engine.loading
      error.value = engine.error
    })

    // ── Unrestricted mode: auto-approve all tool requests ──────────
    engine.onMessage('tool.approval_request', (msg) => {
      engine.approveTool(msg.toolCallId, true)
    })

    await engine.init()

    // Sync state after init resolves
    available.value = engine.available
    workerReady.value = engine.ready
    nodeVersion.value = engine.nodeVersion
    openclawRoot.value = engine.openclawRoot
    loading.value = engine.loading
    error.value = engine.error
  } catch (e) {
    available.value = false
    error.value = `Init failed: ${e.message}`
    loading.value = false
  }
}

// ── Delegate to engine ───────────────────────────────────────────────────

function onMessage(type, handler, opts = {}) {
  return engine.onMessage(type, handler, opts)
}

async function sendMessage(prompt, agentId = 'main') {
  const result = await engine.sendMessage(prompt, agentId)
  return result.sessionKey
}

function setSessionKey(key) {
  engine.setSessionKey(key)
}

function getSessionKey() {
  return engine.currentSessionKey
}

async function stopTurn() {
  return engine.stopTurn()
}

async function approveTool(toolCallId, approved) {
  return engine.approveTool(toolCallId, approved)
}

async function updateConfig(config) {
  return engine.updateConfig(config)
}

async function readFile(path) {
  return engine.readFile(path)
}

async function writeFile(path, content) {
  return engine.writeFile(path, content)
}

async function getAuthStatus() {
  return engine.getAuthStatus()
}

async function listSessions(agentId = 'main') {
  return engine.listSessions(agentId)
}

async function clearConversation() {
  return engine.clearConversation()
}

async function getLatestSession(agentId = 'main') {
  return engine.getLatestSession(agentId)
}

async function loadSessionHistory(sessionKey, agentId = 'main') {
  return engine.loadSessionHistory(sessionKey, agentId)
}

async function resumeSession(sessionKey, agentId = 'main') {
  return engine.resumeSession(sessionKey, agentId)
}

// ── Public composable ────────────────────────────────────────────────────

export function useMobileClaw() {
  // Auto-init on first use (if native)
  if (isNative && !initPromise) init()

  return {
    // State (reactive Vue refs)
    available,
    workerReady,
    nodeVersion,
    openclawRoot,
    loading,
    error,

    // Lifecycle
    init,

    // Agent control
    sendMessage,
    stopTurn,
    approveTool,
    updateConfig,

    // File operations
    readFile,
    writeFile,

    // Settings & session management
    getAuthStatus,
    listSessions,
    clearConversation,
    getLatestSession,
    loadSessionHistory,
    resumeSession,
    setSessionKey,
    getSessionKey,

    // Low-level bridge
    onMessage,
  }
}
