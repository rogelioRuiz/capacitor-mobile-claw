<template>
  <div
    class="h-full overflow-y-auto"
    style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px)"
  >
    <div class="max-w-lg mx-auto px-4 pt-20 pb-12 flex flex-col items-center">

      <!-- App Icon -->
      <div class="w-16 h-16 rounded-2xl bg-primary/20 flex items-center justify-center mb-4">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
             class="text-primary">
          <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
          <rect x="3" y="8" width="18" height="12" rx="2"/>
          <circle cx="9" cy="14" r="1.5" fill="currentColor"/>
          <circle cx="15" cy="14" r="1.5" fill="currentColor"/>
        </svg>
      </div>

      <!-- Title -->
      <h1 class="text-2xl font-bold text-foreground mb-8">Mobile Claw</h1>

      <!-- Worker Status -->
      <div class="w-full mb-6">
        <div class="bg-card/80 backdrop-blur-xl border border-border/50 rounded-xl overflow-hidden
                    shadow-[0_1px_4px_rgba(0,0,0,0.15)]">
          <div class="px-4 py-3">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                     class="text-purple-400">
                  <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
                  <rect x="3" y="8" width="18" height="12" rx="2"/>
                  <circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-foreground">Agent Engine</div>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="workerReady ? 'bg-emerald-400' : 'bg-muted-foreground/60'"
                  />
                  <span class="text-xs" :class="workerReady ? 'text-emerald-400' : 'text-muted-foreground/60'">
                    {{ workerReady ? 'Ready' : (isNative ? 'Starting...' : 'Requires native app') }}
                  </span>
                  <span v-if="nodeVersion" class="text-[0.65rem] text-muted-foreground/50">
                    Node {{ nodeVersion }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Provider Tabs -->
      <div class="w-full mb-4">
        <div class="flex bg-secondary/60 rounded-lg p-0.5">
          <button
            v-for="tab in ['anthropic', 'openrouter', 'openai']"
            :key="tab"
            @click="switchProvider(tab)"
            class="flex-1 py-2 rounded-md text-xs font-medium transition-all duration-150"
            :class="providerTab === tab
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'"
          >
            {{ PROVIDER_LABELS[tab] }}
          </button>
        </div>
      </div>

      <!-- Auth Status -->
      <div class="w-full mb-6">
        <SettingsGroup :label="providerTab.toUpperCase()">
          <div class="px-4 py-4 space-y-3">

            <!-- Status row (shared across all providers) -->
            <div class="flex items-center gap-2">
              <div
                class="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                :class="currentStatus.hasKey ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
              >
                <svg v-if="providerTab !== 'openai'" width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-[0.8125rem] font-medium text-foreground">{{ PROVIDER_LABELS[providerTab] }}</div>
                <div class="text-xs mt-0.5" :class="currentStatus.hasKey ? 'text-emerald-400' : 'text-destructive animate-pulse'">
                  {{ currentStatus.hasKey ? (currentStatus.masked || 'Configured') : 'Not configured' }}
                </div>
              </div>
            </div>

            <!-- ── ANTHROPIC ── -->
            <template v-if="providerTab === 'anthropic'">

              <!-- Sub-tabs: OAuth | API Key -->
              <div class="flex bg-secondary/40 rounded-md p-0.5">
                <button
                  v-for="sub in ['oauth', 'apikey']"
                  :key="sub"
                  @click="authTab = sub"
                  class="flex-1 py-1.5 rounded text-xs font-medium transition-all duration-150"
                  :class="authTab === sub
                    ? 'bg-card/80 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'"
                >
                  {{ sub === 'oauth' ? 'Claude Max (OAuth)' : 'API Key' }}
                </button>
              </div>

              <!-- OAuth sub-tab -->
              <template v-if="authTab === 'oauth'">
                <p class="text-xs text-muted-foreground/70 leading-relaxed">
                  Sign in with your Claude Max subscription. Opens a browser — Anthropic will show you a code to paste here.
                </p>

                <button
                  v-if="!waitingForCode"
                  @click="startOAuthPkce"
                  :disabled="oauthLoading"
                  class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                         disabled:opacity-40 disabled:cursor-not-allowed
                         bg-[#da7756] text-white hover:bg-[#c46a4c] active:scale-[0.98]"
                >
                  {{ oauthLoading ? 'Opening browser...' : (currentStatus.hasKey ? 'Re-authenticate' : 'Sign in with Claude') }}
                </button>

                <template v-if="waitingForCode">
                  <p class="text-xs text-amber-400 leading-relaxed">
                    Copy the code shown by Anthropic and paste it below.
                  </p>
                  <input
                    v-model="oauthCodeInput"
                    type="text"
                    placeholder="Paste authorization code..."
                    class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                           text-sm text-foreground font-mono
                           placeholder:text-muted-foreground/40
                           focus:outline-none focus:ring-2 focus:ring-primary/50
                           transition-colors duration-150"
                    @keyup.enter="submitOAuthCode"
                  />
                  <div class="flex gap-2">
                    <button
                      @click="submitOAuthCode"
                      :disabled="!oauthCodeInput.trim() || oauthLoading"
                      class="flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                             disabled:opacity-40 disabled:cursor-not-allowed
                             bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]"
                    >
                      {{ oauthLoading ? 'Exchanging...' : 'Submit Code' }}
                    </button>
                    <button
                      @click="cancelOAuth"
                      class="px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                             bg-secondary text-muted-foreground hover:text-foreground active:scale-[0.98]"
                    >
                      Cancel
                    </button>
                  </div>
                </template>

                <p v-if="oauthError" class="text-xs text-destructive">{{ oauthError }}</p>
              </template>

              <!-- API Key sub-tab -->
              <template v-else>
                <input
                  v-model="apiKeyInput"
                  type="password"
                  placeholder="sk-ant-api03-..."
                  class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                         text-sm text-foreground font-mono
                         placeholder:text-muted-foreground/40
                         focus:outline-none focus:ring-2 focus:ring-primary/50
                         transition-colors duration-150"
                />
                <p
                  v-if="apiKeyInput && !apiKeyInput.startsWith('sk-ant-')"
                  class="text-xs text-amber-400"
                >
                  Anthropic API keys typically start with "sk-ant-"
                </p>
                <button
                  @click="saveApiKey"
                  :disabled="!apiKeyInput.trim()"
                  class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                         disabled:opacity-40 disabled:cursor-not-allowed"
                  :class="apiKeyInput.trim()
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]'
                    : 'bg-secondary text-muted-foreground'"
                >
                  {{ currentStatus.hasKey ? 'Update Key' : 'Save Key' }}
                </button>
              </template>
            </template>

            <!-- ── OPENROUTER ── -->
            <template v-else-if="providerTab === 'openrouter'">
              <p class="text-xs text-muted-foreground/70 leading-relaxed">
                Sign in with OpenRouter to access 200+ models from Anthropic, OpenAI, Google, and more.
              </p>

              <button
                @click="startOpenRouterOAuth"
                :disabled="openrouterLoading"
                class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                       disabled:opacity-40 disabled:cursor-not-allowed
                       bg-[#6366f1] text-white hover:bg-[#4f52d4] active:scale-[0.98]"
              >
                {{ openrouterLoading ? 'Waiting for callback...' : (currentStatus.hasKey ? 'Re-authenticate' : 'Sign in with OpenRouter') }}
              </button>

              <div class="flex items-center gap-2">
                <div class="flex-1 h-px bg-border/40"/>
                <span class="text-[0.65rem] text-muted-foreground/40 uppercase tracking-wider">or API key</span>
                <div class="flex-1 h-px bg-border/40"/>
              </div>

              <input
                v-model="apiKeyInput"
                type="password"
                placeholder="sk-or-v1-..."
                class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                       text-sm text-foreground font-mono
                       placeholder:text-muted-foreground/40
                       focus:outline-none focus:ring-2 focus:ring-primary/50
                       transition-colors duration-150"
              />
              <p
                v-if="apiKeyInput && !apiKeyInput.startsWith('sk-or-v1-')"
                class="text-xs text-amber-400"
              >
                OpenRouter API keys typically start with "sk-or-v1-"
              </p>
              <button
                @click="saveApiKey"
                :disabled="!apiKeyInput.trim()"
                class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                       disabled:opacity-40 disabled:cursor-not-allowed"
                :class="apiKeyInput.trim()
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]'
                  : 'bg-secondary text-muted-foreground'"
              >
                {{ currentStatus.hasKey ? 'Update Key' : 'Save Key' }}
              </button>
            </template>

            <!-- ── OPENAI ── -->
            <template v-else>
              <p class="text-xs text-muted-foreground/70 leading-relaxed">
                Enter your OpenAI API key. Note: ChatGPT Plus/Pro subscription does not include API access — a separate API key is required.
              </p>

              <input
                v-model="apiKeyInput"
                type="password"
                placeholder="sk-..."
                class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                       text-sm text-foreground font-mono
                       placeholder:text-muted-foreground/40
                       focus:outline-none focus:ring-2 focus:ring-primary/50
                       transition-colors duration-150"
              />
              <p
                v-if="apiKeyInput && !apiKeyInput.startsWith('sk-')"
                class="text-xs text-amber-400"
              >
                OpenAI API keys typically start with "sk-"
              </p>
              <button
                @click="saveApiKey"
                :disabled="!apiKeyInput.trim()"
                class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                       disabled:opacity-40 disabled:cursor-not-allowed"
                :class="apiKeyInput.trim()
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]'
                  : 'bg-secondary text-muted-foreground'"
              >
                {{ currentStatus.hasKey ? 'Update Key' : 'Save Key' }}
              </button>
            </template>

          </div>
        </SettingsGroup>
      </div>

      <!-- Continue Button -->
      <button
        @click="$router.push('/chat')"
        :disabled="!hasAnyKey"
        class="w-full max-w-sm py-3 rounded-xl text-sm font-semibold transition-all duration-200
               disabled:opacity-30 disabled:cursor-not-allowed"
        :class="hasAnyKey
          ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] shadow-lg shadow-primary/20'
          : 'bg-secondary text-muted-foreground'"
      >
        Continue to Chat
      </button>

      <!-- Settings link -->
      <button
        @click="$router.push('/settings')"
        class="mt-6 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150"
      >
        Advanced Settings
      </button>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { App } from '@capacitor/app'
import { useMobileClaw } from '@/composables/useMobileClaw'
import { isNative } from '@/lib/platform.js'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'

const { workerReady, nodeVersion, updateConfig, getAuthStatus, getModels, exchangeOAuthCode } = useMobileClaw()

// ── Provider labels ───────────────────────────────────────────────────────

const PROVIDER_LABELS = {
  anthropic: 'Claude Max',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
}

// ── Tab state ─────────────────────────────────────────────────────────────

const providerTab = ref('anthropic')
const authTab = ref('oauth')    // sub-tab within Anthropic

// ── Per-provider auth status ──────────────────────────────────────────────

const authStatus = ref({
  anthropic: { hasKey: false, masked: '' },
  openrouter: { hasKey: false, masked: '' },
  openai: { hasKey: false, masked: '' },
})

const currentStatus = computed(() => authStatus.value[providerTab.value] || { hasKey: false, masked: '' })
const hasAnyKey = computed(() => Object.values(authStatus.value).some(s => s.hasKey))

// ── Shared API key input (reset on tab switch) ────────────────────────────

const apiKeyInput = ref('')

// ── Anthropic OAuth state ─────────────────────────────────────────────────

const oauthLoading = ref(false)
const oauthError = ref('')
const waitingForCode = ref(false)
const oauthCodeInput = ref('')
let _pendingVerifier = null

// ── OpenRouter OAuth state ────────────────────────────────────────────────

const openrouterLoading = ref(false)
let _appUrlListener = null
let _anthropicOAuthActive = false

// ── OAuth PKCE constants (Anthropic) ──────────────────────────────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference'

// ── OpenRouter OAuth constants ────────────────────────────────────────────

const OPENROUTER_CALLBACK = 'io.mobileclaw.reference://openrouter/callback'
const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'

// ── Auth status helpers ───────────────────────────────────────────────────

async function loadAuthStatus(provider) {
  if (!workerReady.value) return
  try {
    const status = await getAuthStatus(provider)
    authStatus.value[provider] = { hasKey: status.hasKey, masked: status.masked || '' }
  } catch { /* non-fatal */ }
}

async function loadAllAuthStatus() {
  await Promise.all(['anthropic', 'openrouter', 'openai'].map(p => loadAuthStatus(p)))
}

const ACTIVE_MODEL_KEY = 'mobileclaw_active_model'

function readStoredActiveModel() {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_MODEL_KEY) || '{}')
  } catch {
    return {}
  }
}

async function persistActiveModel(provider) {
  const stored = readStoredActiveModel()
  let model = stored.provider === provider ? (stored.model || '') : ''

  try {
    const result = await getModels(provider)
    const models = result.models || []
    if (model && !models.some(m => m.id === model)) {
      model = ''
    }
    if (!model) {
      const def = models.find(m => m.default) || models[0]
      model = def?.id || ''
    }
  } catch { /* non-fatal */ }

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(ACTIVE_MODEL_KEY, JSON.stringify({ provider, model }))
  }
}

async function saveApiKey() {
  if (!apiKeyInput.value.trim()) return
  await updateConfig({
    action: 'setApiKey',
    provider: providerTab.value,
    apiKey: apiKeyInput.value.trim(),
  })
  await persistActiveModel(providerTab.value)
  apiKeyInput.value = ''
  await loadAuthStatus(providerTab.value)
}

function switchProvider(tab) {
  providerTab.value = tab
  apiKeyInput.value = ''
  oauthError.value = ''
}

// ── Anthropic PKCE helpers ────────────────────────────────────────────────

function generateRandomBytes(length) {
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return arr
}

function base64urlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generatePKCE() {
  const verifier = base64urlEncode(generateRandomBytes(32))
  const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64urlEncode(challengeBuffer)
  return { verifier, challenge }
}

// ── Anthropic OAuth flow ──────────────────────────────────────────────────

async function startOAuthPkce() {
  oauthLoading.value = true
  oauthError.value = ''

  try {
    const { verifier, challenge } = await generatePKCE()
    _pendingVerifier = verifier

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: verifier,
    })

    const authUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`

    if (isNative) {
      // Use Capacitor Browser plugin (in-app browser) — works on both iOS and Android.
      // Anthropic's redirect goes to console.anthropic.com (not back to the app),
      // so the deep link won't fire. Their callback page shows the auth code for the
      // user to copy. We show a paste-code UI when the browser closes.
      const { Browser } = await import('@capacitor/browser')

      let closedHandle = null
      const cleanup = async () => {
        const c = closedHandle; closedHandle = null
        if (c) { try { const h = await c; h.remove() } catch {} }
      }

      Browser.open({ url: authUrl, presentationStyle: 'popover' }).then(() => {
        // Listen for deep link callback (future-proof, in case Anthropic adds redirect support)
        const existingHandler = _appUrlListener
        const originalHandleAppUrl = handleAppUrl
        // Temporarily augment the global handler to catch Anthropic OAuth codes
        _anthropicOAuthActive = true

        // When user closes browser → show code-paste UI
        closedHandle = Browser.addListener('browserFinished', () => {
          cleanup()
          _anthropicOAuthActive = false
          waitingForCode.value = true
          oauthLoading.value = false
        })
      })
    } else {
      // Web fallback: open in new tab
      if (typeof window !== 'undefined' && window.open) {
        window.open(authUrl, '_system')
      }
      waitingForCode.value = true
      oauthLoading.value = false
    }
  } catch (e) {
    oauthError.value = `OAuth error: ${e.message}`
    oauthLoading.value = false
  }
}

async function submitOAuthCode() {
  const rawCode = oauthCodeInput.value.trim()
  if (!rawCode || !_pendingVerifier) return

  oauthLoading.value = true
  oauthError.value = ''

  try {
    const cleanCode = rawCode.split('#')[0].split('&')[0]
    const verifier = _pendingVerifier

    const result = await exchangeOAuthCode(OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code: cleanCode,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
      state: verifier,
    }, 'application/json')

    if (!result.success) {
      throw new Error(`Token exchange failed: ${result.status || ''} ${result.text || result.error || 'Unknown error'}`)
    }

    const data = result.data
    await updateConfig({
      action: 'setOAuth',
      provider: 'anthropic',
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
    })
    await persistActiveModel('anthropic')

    oauthCodeInput.value = ''
    waitingForCode.value = false
    _pendingVerifier = null
    await loadAuthStatus('anthropic')
  } catch (e) {
    oauthError.value = e.message
  } finally {
    oauthLoading.value = false
  }
}

function cancelOAuth() {
  waitingForCode.value = false
  oauthCodeInput.value = ''
  oauthError.value = ''
  _pendingVerifier = null
}

// ── OpenRouter OAuth flow ─────────────────────────────────────────────────

async function startOpenRouterOAuth() {
  openrouterLoading.value = true
  const authUrl = `${OPENROUTER_AUTH_URL}?callback_url=${encodeURIComponent(OPENROUTER_CALLBACK)}`

  if (isNative) {
    const { Browser } = await import('@capacitor/browser')

    let closedHandle = null
    const cleanup = async () => {
      const c = closedHandle; closedHandle = null
      if (c) { try { const h = await c; h.remove() } catch {} }
    }

    Browser.open({ url: authUrl, presentationStyle: 'popover' }).then(() => {
      closedHandle = Browser.addListener('browserFinished', () => {
        cleanup()
        openrouterLoading.value = false
      })
    })
  } else {
    if (typeof window !== 'undefined' && window.open) {
      window.open(authUrl, '_system')
    }
  }
}

// ── App URL listener (deep links) ─────────────────────────────────────────

async function handleAppUrl(event) {
  const url = event.url || ''

  // Anthropic OAuth deep link (future-proof — Anthropic may add redirect support)
  if (url.includes('oauth/code/callback') && _anthropicOAuthActive && _pendingVerifier) {
    _anthropicOAuthActive = false
    try {
      const { Browser } = await import('@capacitor/browser')
      Browser.close().catch(() => {})
    } catch {}
    try {
      const parsed = new URL(url)
      const code = parsed.searchParams.get('code') || ''
      if (code) {
        oauthCodeInput.value = code
        await submitOAuthCode()
      }
    } catch { /* non-fatal */ }
    return
  }

  // OpenRouter returns the API key as ?code=<key> in the callback URL
  if (url.includes('openrouter/callback')) {
    openrouterLoading.value = false
    try {
      const { Browser } = await import('@capacitor/browser')
      Browser.close().catch(() => {})
    } catch {}
    try {
      const parsed = new URL(url)
      const key = parsed.searchParams.get('code')
      if (key) {
        await updateConfig({
          action: 'setApiKey',
          provider: 'openrouter',
          apiKey: key,
        })
        await persistActiveModel('openrouter')
        await loadAuthStatus('openrouter')
        providerTab.value = 'openrouter'
      }
    } catch { /* non-fatal */ }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

onMounted(async () => {
  if (isNative) {
    _appUrlListener = await App.addListener('appUrlOpen', handleAppUrl)
  }
})

onUnmounted(() => {
  if (_appUrlListener) {
    _appUrlListener.remove()
    _appUrlListener = null
  }
  openrouterLoading.value = false
})

watch(workerReady, (ready) => {
  if (ready) loadAllAuthStatus()
}, { immediate: true })
</script>
