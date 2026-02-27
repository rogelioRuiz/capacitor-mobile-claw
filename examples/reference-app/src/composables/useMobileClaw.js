/**
 * useMobileClaw — Vue composable for the Mobile Claw reference app.
 *
 * Simplified wrapper around MobileClawEngine with:
 * - Auto-approve all tool requests (unrestricted mode)
 * - No MCP state management
 * - No backend/auth integration
 * - Memory system integration (auto-recall, auto-capture, agent tools)
 */

import { ref } from 'vue'
import { MobileClawEngine } from 'capacitor-mobile-claw'
import { isNative } from '@/lib/platform.js'
import { useMemory } from './useMemory.js'

// ── Module-level singleton ───────────────────────────────────────────────

const engine = new MobileClawEngine()
const { memory, initMemory, reindex, loadSavedConfig } = useMemory()

const available = ref(false)
const workerReady = ref(false)
const nodeVersion = ref(null)
const openclawRoot = ref(null)
const loading = ref(false)
const error = ref(null)

let initPromise = null
let lastUserPrompt = null

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

    // ── Unrestricted mode: auto-approve all tool calls via pre-execute hook ──
    engine.onMessage('tool.pre_execute', (msg) => {
      engine.respondToPreExecute(msg.toolCallId, msg.args)
    })

    // ── Initialize memory system ──
    const savedConfig = loadSavedConfig()
    await initMemory(savedConfig)

    // Pass memory tools to engine init so the agent can use them
    const memoryTools = memory.getTools()
    await engine.init({ tools: memoryTools })

    // Set readFile for memory_get tool
    memory.setReadFile((path) => engine.readFile(path))

    // Sync state after init resolves
    available.value = engine.available
    workerReady.value = engine.ready
    nodeVersion.value = engine.nodeVersion
    openclawRoot.value = engine.openclawRoot
    loading.value = engine.loading
    error.value = engine.error

    // ── Dev helper: expose engine on window for CDP testing ──
    window.__mobileClaw = engine

    // ── Index workspace memory files (non-blocking) ──
    reindex(
      (path) => engine.readFile(path),
      (name, args) => engine.invokeTool(name, args),
    ).catch(() => { /* non-fatal */ })

    // ── Auto-capture on agent completion ──
    engine.onMessage('agent.completed', async () => {
      if (lastUserPrompt) {
        await memory.capture(lastUserPrompt).catch(() => {})
        lastUserPrompt = null
      }
    })
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
  lastUserPrompt = prompt

  // ── Auto-recall: inject relevant memories ──
  let enrichedPrompt = prompt
  try {
    const context = await memory.recall(prompt)
    if (context) enrichedPrompt = context + '\n\n' + prompt
  } catch { /* non-fatal — send without context */ }

  const result = await engine.sendMessage(enrichedPrompt, agentId)
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

async function invokeTool(toolName, args = {}) {
  return engine.invokeTool(toolName, args)
}

async function exchangeOAuthCode(tokenUrl, body, contentType) {
  return engine.exchangeOAuthCode(tokenUrl, body, contentType)
}

// ── Public composable ────────────────────────────────────────────────────

export function useMobileClaw() {
  // Auto-init on first use (if native)
  if (isNative && !initPromise) init()

  return {
    engine,

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

    // OAuth
    exchangeOAuthCode,

    // Low-level bridge
    onMessage,
    invokeTool,
  }
}
