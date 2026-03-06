<template>
  <div class="h-full flex flex-col relative chat-layout">

    <!-- Header -->
    <div
      class="absolute top-0 left-0 right-0 z-20 flex items-center justify-between
             px-4 py-3 bg-background/70 backdrop-blur-xl
             border-b border-border/20"
      style="padding-top: max(0.75rem, env(safe-area-inset-top, 0px))"
    >
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
               class="text-primary">
            <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
            <rect x="3" y="8" width="18" height="12" rx="2"/>
            <circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>
          </svg>
        </div>
        <div>
          <div class="text-sm font-semibold text-foreground leading-tight">Mobile Claw</div>
          <div class="flex items-center gap-1">
            <span
              class="w-1 h-1 rounded-full"
              :class="isRunning ? 'bg-primary animate-pulse' : (workerReady ? 'bg-emerald-400' : 'bg-muted-foreground/60')"
            />
            <span class="text-[0.6rem] text-muted-foreground/60">
              {{ isRunning ? 'Thinking...' : (workerReady ? 'Ready' : 'Offline') }}
            </span>
          </div>
        </div>
      </div>

      <!-- Settings button -->
      <div class="flex items-center gap-1">
        <button
          @click="$router.push('/settings')"
          class="w-8 h-8 rounded-lg flex items-center justify-center
                 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground
                 active:scale-[0.92] transition-all duration-150"
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages area -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto conversation-fade relative"
      style="padding-top: calc(60px + env(safe-area-inset-top, 0px))"
    >
      <!-- Restoring session indicator -->
      <div v-if="restoringSession" class="flex-1 flex items-center justify-center">
        <div class="flex items-center gap-2 text-muted-foreground/50">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          <span class="text-xs">Restoring conversation...</span>
        </div>
      </div>

      <!-- Empty state -->
      <ChatEmptyState
        v-if="messages.length === 0 && !isRunning && !restoringSession"
        @suggest="handleSend"
      />

      <!-- Messages -->
      <div v-else class="flex flex-col gap-6 p-4 pb-4">
        <ChatMessage
          v-for="msg in messages"
          :key="msg.id"
          :from="msg.from"
          :content="msg.content"
          :streaming="msg.streaming"
          :timestamp="msg.timestamp"
        />

        <!-- Thinking indicator -->
        <div v-if="isRunning && !currentStreamingMessage" class="flex items-center gap-2 pl-1">
          <div class="flex gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[pulse_1.4s_ease-in-out_infinite]" />
            <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
            <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
          </div>
          <span class="text-xs text-muted-foreground/50">Thinking...</span>
        </div>
      </div>
    </div>

    <!-- Input -->
    <ChatInput
      ref="chatInput"
      :is-running="isRunning"
      :worker-ready="workerReady"
      @send="handleSend"
      @stop="handleStop"
    />
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useMobileClaw } from '@/composables/useMobileClaw'
import ChatMessage from '@/components/chat/ChatMessage.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import ChatEmptyState from '@/components/chat/ChatEmptyState.vue'

const {
  workerReady, sendMessage, stopTurn, onMessage,
  clearConversation, getAuthStatus,
  getLatestSession, getModels, loadSessionHistory, resumeSession, setSessionKey,
} = useMobileClaw()

const messages = ref([])
const isRunning = ref(false)
const currentStreamingMessage = ref(null)
const messagesContainer = ref(null)
const chatInput = ref(null)
const restoringSession = ref(false)

let messageIdCounter = 0
let cleanupFns = []
const PROVIDERS = ['anthropic', 'openrouter', 'openai']
const ACTIVE_MODEL_KEY = 'mobileclaw_active_model'

function readStoredProviderModel() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_MODEL_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveProviderModel(provider, model) {
  localStorage.setItem(ACTIVE_MODEL_KEY, JSON.stringify({ provider, model: model || '' }))
}

async function getDefaultModel(provider, preferredModel) {
  try {
    const result = await getModels(provider)
    const models = result.models || []
    if (preferredModel && models.some(m => m.id === preferredModel)) {
      return preferredModel
    }
    const def = models.find(m => m.default) || models[0]
    return def?.id || ''
  } catch {
    return preferredModel || ''
  }
}

async function resolveProviderModel() {
  const stored = readStoredProviderModel()
  if (stored.provider) {
    const model = await getDefaultModel(stored.provider, stored.model)
    saveProviderModel(stored.provider, model)
    return { provider: stored.provider, model }
  }

  const results = await Promise.allSettled(PROVIDERS.map(p => getAuthStatus(p)))
  const firstConfigured = results.find((r) => r.status === 'fulfilled' && r.value?.hasKey)
  if (!firstConfigured) {
    return { provider: '', model: '' }
  }

  const provider = firstConfigured.value.provider
  const model = await getDefaultModel(provider, '')
  saveProviderModel(provider, model)
  return { provider, model }
}

function generateId() {
  return `msg-${++messageIdCounter}`
}

function scrollToBottom() {
  nextTick(() => {
    const container = messagesContainer.value
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    }
  })
}

async function handleSend(text) {
  // Add user message
  messages.value.push({
    id: generateId(),
    from: 'user',
    content: text,
    streaming: false,
    timestamp: Date.now(),
  })
  scrollToBottom()

  isRunning.value = true
  currentStreamingMessage.value = null

  try {
    const resolved = await resolveProviderModel()
    const sessionKey = await sendMessage(text, 'main', {
      provider: resolved.provider || undefined,
      model: resolved.model || undefined,
    })
  } catch (err) {
    isRunning.value = false
    messages.value.push({
      id: generateId(),
      from: 'assistant',
      content: `Error: ${err.message}`,
      streaming: false,
      timestamp: Date.now(),
    })
    scrollToBottom()
  }
}

function handleStop() {
  stopTurn()
}

async function startNewChat() {
  if (isRunning.value) {
    stopTurn()
    await new Promise(r => setTimeout(r, 500))
  }
  await clearConversation()
  setSessionKey(null)
  messages.value = []
  currentStreamingMessage.value = null
  isRunning.value = false
  nextTick(() => chatInput.value?.focus())
}

// ── Event listeners ─────────────────────────────────────────────────────────

onMounted(() => {
  // Text delta — streaming text from the agent
  const removeTextDelta = onMessage('agent.event', (msg) => {
    if (msg.eventType === 'text_delta' && msg.data?.text) {
      if (!currentStreamingMessage.value) {
        const newMsg = {
          id: generateId(),
          from: 'assistant',
          content: msg.data.text,
          streaming: true,
          timestamp: Date.now(),
        }
        messages.value.push(newMsg)
        currentStreamingMessage.value = newMsg.id
      } else {
        const existing = messages.value.find(m => m.id === currentStreamingMessage.value)
        if (existing) {
          existing.content += msg.data.text
        }
      }
      scrollToBottom()
    }
  })
  cleanupFns.push(removeTextDelta)

  // Agent completed
  const removeCompleted = onMessage('agent.completed', () => {
    if (currentStreamingMessage.value) {
      const existing = messages.value.find(m => m.id === currentStreamingMessage.value)
      if (existing) existing.streaming = false
    }
    isRunning.value = false
    currentStreamingMessage.value = null
    scrollToBottom()
  })
  cleanupFns.push(removeCompleted)

  // Agent error
  const removeError = onMessage('agent.error', (msg) => {
    if (currentStreamingMessage.value) {
      const existing = messages.value.find(m => m.id === currentStreamingMessage.value)
      if (existing) {
        existing.streaming = false
        if (!existing.content) {
          existing.content = `Error: ${msg.error || 'Unknown error'}`
        }
      }
    } else {
      messages.value.push({
        id: generateId(),
        from: 'assistant',
        content: `Error: ${msg.error || 'Unknown error'}`,
        streaming: false,
        timestamp: Date.now(),
      })
    }
    isRunning.value = false
    currentStreamingMessage.value = null
    scrollToBottom()
  })
  cleanupFns.push(removeError)

  // User message echo (for multi-turn context display)
  const removeUserMsg = onMessage('agent.event', (msg) => {
    if (msg.eventType === 'user_message') {
      // Already added by handleSend, skip duplicate
    }
  })
  cleanupFns.push(removeUserMsg)
})

onUnmounted(() => {
  cleanupFns.forEach(fn => { if (typeof fn === 'function') fn() })
  cleanupFns = []
})

// Auto-restore the latest session on mount (if any)
watch(workerReady, async (ready) => {
  if (!ready || messages.value.length > 0) return
  try {
    const resolved = await resolveProviderModel()
    if (!resolved.provider) return

    const status = await getAuthStatus(resolved.provider)
    if (!status.hasKey) return

    const latest = await getLatestSession()
    if (!latest?.sessionKey) return

    restoringSession.value = true
    const history = await loadSessionHistory(latest.sessionKey)
    if (!history?.messages?.length) { restoringSession.value = false; return }

    // Convert session.load.result messages to ChatView format
    for (const m of history.messages) {
      if (m.role === 'user') {
        messages.value.push({
          id: generateId(),
          from: 'user',
          content: typeof m.content === 'string' ? m.content : '',
          streaming: false,
          timestamp: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
        })
      } else if (m.role === 'assistant') {
        const text = Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('')
          : (typeof m.content === 'string' ? m.content : '')
        if (text) {
          messages.value.push({
            id: generateId(),
            from: 'assistant',
            content: text,
            streaming: false,
            timestamp: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
          })
        }
      }
      // Skip tool_use and tool_result — reference app is text-only
    }

    // Resume agent context for follow-ups
    await resumeSession(latest.sessionKey, 'main', {
      provider: resolved.provider,
      model: latest.model || resolved.model,
    })
    setSessionKey(latest.sessionKey)
    scrollToBottom()
  } catch { /* non-fatal — just show empty chat */ }
  finally { restoringSession.value = false }
}, { immediate: true })
</script>
