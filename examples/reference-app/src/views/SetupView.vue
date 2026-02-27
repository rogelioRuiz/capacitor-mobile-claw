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
      <h1 class="text-2xl font-bold text-foreground mb-1">Mobile Claw</h1>
      <p class="text-sm text-muted-foreground mb-8 text-center">
        On-device AI agent powered by Anthropic
      </p>

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

      <!-- Auth Method Tabs -->
      <div class="w-full mb-4">
        <div class="flex bg-secondary/60 rounded-lg p-0.5">
          <button
            v-for="tab in ['oauth', 'apikey']"
            :key="tab"
            @click="authTab = tab"
            class="flex-1 py-2 rounded-md text-xs font-medium transition-all duration-150"
            :class="authTab === tab
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'"
          >
            {{ tab === 'oauth' ? 'Claude Max (OAuth)' : 'API Key' }}
          </button>
        </div>
      </div>

      <!-- Auth Status -->
      <div class="w-full mb-6">
        <SettingsGroup :label="authTab === 'oauth' ? 'CLAUDE MAX' : 'API KEY'">
          <div class="px-4 py-4 space-y-3">
            <!-- Status row -->
            <div class="flex items-center gap-2">
              <div
                class="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                :class="hasApiKey ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
              >
                <svg v-if="authTab === 'oauth'" width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-[0.8125rem] font-medium text-foreground">
                  {{ authTab === 'oauth' ? 'Anthropic OAuth' : 'Anthropic API Key' }}
                </div>
                <div class="text-xs mt-0.5" :class="hasApiKey ? 'text-emerald-400' : 'text-destructive animate-pulse'">
                  {{ hasApiKey ? (apiKeyMasked || 'Configured') : 'Not configured' }}
                </div>
              </div>
            </div>

            <!-- OAuth tab -->
            <template v-if="authTab === 'oauth'">
              <p class="text-xs text-muted-foreground/70 leading-relaxed">
                Sign in with your Claude Max subscription. Opens a browser — Anthropic will show you a code to paste here.
              </p>

              <!-- Step 1: Open browser -->
              <button
                v-if="!waitingForCode"
                @click="startOAuthPkce"
                :disabled="!workerReady || oauthLoading"
                class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                       disabled:opacity-40 disabled:cursor-not-allowed
                       bg-[#da7756] text-white hover:bg-[#c46a4c] active:scale-[0.98]"
              >
                {{ oauthLoading ? 'Opening browser...' : (hasApiKey ? 'Re-authenticate' : 'Sign in with Claude') }}
              </button>

              <!-- Step 2: Paste code -->
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

            <!-- API Key tab -->
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
                {{ hasApiKey ? 'Update Key' : 'Save Key' }}
              </button>
            </template>
          </div>
        </SettingsGroup>
      </div>

      <!-- Continue Button -->
      <button
        @click="$router.push('/chat')"
        :disabled="!hasApiKey"
        class="w-full max-w-sm py-3 rounded-xl text-sm font-semibold transition-all duration-200
               disabled:opacity-30 disabled:cursor-not-allowed"
        :class="hasApiKey
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
import { ref, watch } from 'vue'
import { useMobileClaw } from '@/composables/useMobileClaw'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'

const { workerReady, nodeVersion, updateConfig, getAuthStatus, exchangeOAuthCode } = useMobileClaw()

const authTab = ref('oauth')
const apiKeyInput = ref('')
const hasApiKey = ref(false)
const apiKeyMasked = ref('')
const oauthLoading = ref(false)
const oauthError = ref('')
const waitingForCode = ref(false)
const oauthCodeInput = ref('')

// ── OAuth PKCE constants (matches orchestrator backend client) ────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference'

// PKCE verifier stored for the code exchange step
let _pendingVerifier = null

// ── Helpers ──────────────────────────────────────────────────────────────

async function loadAuthStatus() {
  if (!workerReady.value) return
  try {
    const status = await getAuthStatus()
    hasApiKey.value = status.hasKey
    apiKeyMasked.value = status.masked || ''
  } catch { /* non-fatal */ }
}

async function saveApiKey() {
  if (!apiKeyInput.value.trim()) return
  await updateConfig({
    action: 'setApiKey',
    provider: 'anthropic',
    apiKey: apiKeyInput.value.trim(),
  })
  apiKeyInput.value = ''
  await loadAuthStatus()
}

// ── PKCE helpers ─────────────────────────────────────────────────────────

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

// ── OAuth flow ────────────────────────────────────────────────────────────

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
      state: verifier, // Anthropic convention: state = verifier
    })

    const authUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`

    if (typeof window !== 'undefined' && window.open) {
      window.open(authUrl, '_system')
    }

    // Show code input — Anthropic's callback page displays the code for the user to copy
    waitingForCode.value = true
  } catch (e) {
    oauthError.value = `OAuth error: ${e.message}`
  } finally {
    oauthLoading.value = false
  }
}

async function submitOAuthCode() {
  const rawCode = oauthCodeInput.value.trim()
  if (!rawCode || !_pendingVerifier) return

  oauthLoading.value = true
  oauthError.value = ''

  try {
    // Anthropic's callback returns "code#state" — strip #state suffix
    const cleanCode = rawCode.split('#')[0].split('&')[0]
    const verifier = _pendingVerifier

    // Delegate token exchange to Node.js worker (bypasses CORS)
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

    oauthCodeInput.value = ''
    waitingForCode.value = false
    _pendingVerifier = null
    await loadAuthStatus()
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

// ── Lifecycle ────────────────────────────────────────────────────────────

watch(workerReady, (ready) => {
  if (ready) loadAuthStatus()
}, { immediate: true })
</script>
