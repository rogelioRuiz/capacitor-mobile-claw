<template>
  <div
    class="h-full overflow-y-auto"
    style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px)"
  >
    <OverdueToast :count="overdueJobs.length" />
    <div class="max-w-lg mx-auto px-4 pt-16 pb-12 md:pt-6">

      <!-- Header -->
      <div class="flex items-center gap-3 mb-6">
        <button
          class="flex items-center justify-center w-8 h-8 rounded-lg
                 text-muted-foreground transition-colors duration-150
                 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.95]"
          @click="goBack"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 3L5 8l5 5"/>
          </svg>
        </button>
        <h1 class="text-lg font-semibold text-foreground">Settings</h1>
      </div>

      <!-- Worker Status -->
      <div class="mb-5">
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
                <div class="text-sm font-semibold text-foreground">Mobile Claw</div>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="workerReady ? 'bg-emerald-400' : 'bg-muted-foreground/60'"
                  />
                  <span class="text-xs" :class="workerReady ? 'text-emerald-400' : 'text-muted-foreground/60'">
                    {{ workerReady ? 'Ready' : 'Offline' }}
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

      <!-- API Key -->
      <SettingsGroup label="API KEY">
        <SettingsRow
          label="Anthropic API Key"
          :subtitle="apiKeyStatus"
          :clickable="true"
          :show-chevron="true"
          icon-color="bg-amber-500/15 text-amber-400"
          @click="showApiKeyDialog = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
            </svg>
          </template>
          <template #right>
            <span v-if="hasApiKey" class="text-xs text-emerald-400">Configured</span>
            <span v-else class="text-xs text-destructive animate-pulse">Not configured</span>
          </template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Workspace Editor -->
      <div class="mb-5">
        <div class="px-4 pb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Workspace
        </div>
        <div class="bg-card/80 backdrop-blur-xl border border-border/50 rounded-xl overflow-hidden
                    shadow-[0_1px_4px_rgba(0,0,0,0.15)]">

          <!-- File tabs -->
          <div class="flex gap-1 px-3 pt-3 pb-2">
            <button
              v-for="file in files"
              :key="file.name"
              @click="selectFile(file)"
              class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150"
              :class="activeFile === file.name
                ? 'bg-purple-500/20 text-purple-300'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'"
            >
              {{ file.label }}
            </button>
          </div>

          <!-- File info bar -->
          <div class="px-4 py-1.5 border-t border-border/20 flex items-center justify-between">
            <span class="text-[0.65rem] text-muted-foreground/60 font-mono">{{ activeFile }}</span>
            <span v-if="dirty" class="text-[0.65rem] text-amber-400">Unsaved</span>
            <span v-if="justSaved" class="text-[0.65rem] text-emerald-400">Saved</span>
          </div>

          <!-- Markdown toolbar -->
          <div class="flex gap-0.5 px-3 py-1 border-t border-border/20">
            <button
              v-for="btn in toolbarButtons"
              :key="btn.label"
              @click="insertMarkdown(btn.prefix, btn.suffix)"
              class="w-7 h-7 flex items-center justify-center rounded text-xs font-bold
                     text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground
                     transition-colors duration-100"
              :title="btn.title"
            >
              {{ btn.label }}
            </button>
          </div>

          <!-- Textarea editor -->
          <div class="border-t border-border/20">
            <div v-if="loadingFile" class="px-4 py-8 text-center text-sm text-muted-foreground/60">
              Loading...
            </div>
            <textarea
              v-else
              ref="editorRef"
              v-model="content"
              class="w-full min-h-[280px] px-4 py-3 bg-transparent text-sm text-foreground
                     font-mono leading-relaxed resize-y outline-none
                     placeholder:text-muted-foreground/40"
              placeholder="Write markdown content..."
              @input="onInput"
            />
          </div>

          <!-- Save / Revert buttons -->
          <div v-if="dirty" class="flex justify-end gap-2 px-3 py-2 border-t border-border/20">
            <button
              @click="revert"
              class="px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground
                     hover:bg-foreground/[0.06] transition-colors duration-150"
            >
              Revert
            </button>
            <button
              @click="save"
              :disabled="saving"
              class="px-3 py-1.5 rounded-md text-xs font-medium
                     bg-primary/20 text-primary hover:bg-primary/30
                     disabled:opacity-50 transition-colors duration-150"
            >
              {{ saving ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Memory -->
      <SettingsGroup label="MEMORY">
        <SettingsRow
          label="OpenAI Embedding Key"
          :subtitle="embeddingKeyStatus"
          :clickable="true"
          :show-chevron="true"
          icon-color="bg-sky-500/15 text-sky-400"
          @click="showEmbeddingKeyDialog = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </template>
          <template #right>
            <span v-if="hasEmbeddingKey" class="text-xs text-emerald-400">Configured</span>
            <span v-else class="text-xs text-muted-foreground/50">Local hash</span>
          </template>
        </SettingsRow>
        <SettingsRow
          label="Auto-Recall"
          subtitle="Inject relevant memories before each turn"
          icon-color="bg-violet-500/15 text-violet-400"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </template>
          <template #right>
            <SettingsSwitch :model-value="autoRecall" @update:model-value="toggleAutoRecall" />
          </template>
        </SettingsRow>
        <SettingsRow
          label="Auto-Capture"
          subtitle="Detect and store memorable user content"
          icon-color="bg-pink-500/15 text-pink-400"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
            </svg>
          </template>
          <template #right>
            <SettingsSwitch :model-value="autoCapture" @update:model-value="toggleAutoCapture" />
          </template>
        </SettingsRow>
        <SettingsRow
          label="Stored Memories"
          :subtitle="`${memoryCount} entries in vector database`"
          icon-color="bg-emerald-500/15 text-emerald-400"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          </template>
        </SettingsRow>
        <SettingsRow
          label="Re-index Files"
          subtitle="Re-chunk MEMORY.md + memory/*.md into vector search"
          :clickable="true"
          icon-color="bg-orange-500/15 text-orange-400"
          @click="handleReindex"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
          </template>
          <template #right>
            <span v-if="indexing" class="text-xs text-amber-400">Indexing...</span>
          </template>
        </SettingsRow>
        <SettingsRow
          label="Clear All Memories"
          subtitle="Delete all vector memories. File-based memory is preserved."
          :clickable="true"
          :destructive="true"
          @click="confirmClearMemories"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Scheduled Tasks -->
      <SettingsGroup label="SCHEDULED TASKS">
        <SettingsRow
          label="Enabled"
          subtitle="Enable the scheduler for heartbeat and cron jobs"
          icon-color="bg-indigo-500/15 text-indigo-300"
        >
          <template #right>
            <SettingsSwitch :model-value="schedulerConfig?.enabled ?? false" @update:model-value="toggleSchedulerEnabled" />
          </template>
        </SettingsRow>

        <SettingsRow
          label="Scheduling Mode"
          :subtitle="(schedulerConfig?.schedulingMode || 'balanced').toUpperCase()"
          :clickable="true"
          @click="setSchedulingMode(schedulerConfig?.schedulingMode === 'eco' ? 'balanced' : schedulerConfig?.schedulingMode === 'balanced' ? 'aggressive' : 'eco')"
        />

        <SettingsRow
          label="Global Active Hours"
          :subtitle="schedulerConfig?.globalActiveHours ? `${schedulerConfig.globalActiveHours.start}-${schedulerConfig.globalActiveHours.end} (${schedulerConfig.globalActiveHours.tz || 'UTC'})` : 'Always active'"
          :clickable="true"
          :show-chevron="true"
          @click="openActiveHoursDialog('global', schedulerConfig?.globalActiveHours)"
        />

        <SettingsRow
          label="Run When Charging"
          subtitle="Prefer charging windows for heavy wakeups"
        >
          <template #right>
            <SettingsSwitch :model-value="schedulerConfig?.runOnCharging ?? false" @update:model-value="toggleRunOnCharging" />
          </template>
        </SettingsRow>

        <IosOnboardingBanner
          :show="showIosOnboarding"
          :enabled-at="Number(localStorage.getItem('sentinel-enabled-at') || 0)"
          @dismiss="dismissIosOnboarding"
        />

        <div class="px-4 py-2 border-t border-border/20 text-[0.72rem] text-muted-foreground/70">
          Platform Status: {{ /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iOS BGRefresh registered' : 'Android WorkManager active' }}
        </div>
      </SettingsGroup>

      <!-- Heartbeat -->
      <SettingsGroup label="HEARTBEAT">
        <SettingsRow label="Enabled" subtitle="Run periodic sentinel checks">
          <template #right>
            <SettingsSwitch :model-value="heartbeatConfig?.enabled ?? false" @update:model-value="toggleHeartbeatEnabled" />
          </template>
        </SettingsRow>

        <SettingsRow
          label="Check Every"
          :subtitle="`${Math.round((heartbeatConfig?.everyMs || 1800000) / 60000)} minutes`"
          :clickable="true"
          :show-chevron="true"
          @click="setHeartbeatEvery(heartbeatIntervals.find((o) => o.value > (heartbeatConfig?.everyMs || 1800000))?.value || heartbeatIntervals[0].value)"
        />

        <SettingsRow
          label="Skill"
          :subtitle="cronSkills.find((s) => s.id === heartbeatConfig?.skillId)?.name || 'Default heartbeat skill'"
          :clickable="true"
          :show-chevron="true"
          @click="setHeartbeatSkill(cronSkills[0]?.id || '')"
        />

        <SettingsRow
          label="Active Hours"
          :subtitle="heartbeatConfig?.activeHours ? `${heartbeatConfig.activeHours.start}-${heartbeatConfig.activeHours.end} (${heartbeatConfig.activeHours.tz || 'UTC'})` : 'Always active'"
          :clickable="true"
          :show-chevron="true"
          @click="openActiveHoursDialog('heartbeat', heartbeatConfig?.activeHours)"
        />

        <SettingsRow
          label="Edit HEARTBEAT.md"
          subtitle="Switches to HEARTBEAT.md in the workspace editor"
          :clickable="true"
          :show-chevron="true"
          @click="selectFile({ name: 'HEARTBEAT.md' })"
        />

        <SettingsRow
          label="Trigger Now"
          :subtitle="heartbeatStatusLine"
          :clickable="true"
          :show-chevron="true"
          @click="triggerHeartbeat"
        />
      </SettingsGroup>

      <!-- Cron Jobs -->
      <SettingsGroup label="CRON JOBS">
        <SettingsRow
          v-for="job in cronJobs"
          :key="job.id"
          :label="job.name"
          :subtitle="formatJobSubtitle(job)"
          :clickable="true"
          :show-chevron="true"
          @click="openJobDialog(job)"
        >
          <template #right>
            <button
              class="w-10 h-6 rounded-full relative transition-colors duration-200"
              :class="job.enabled ? 'bg-primary' : 'bg-muted-foreground/30'"
              @click.stop="updateJob(job.id, { enabled: !job.enabled })"
            >
              <span
                class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
                :class="job.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'"
              />
            </button>
          </template>
        </SettingsRow>

        <SettingsRow
          label="Add Cron Job"
          subtitle="Create a scheduled job with isolated or main-session execution"
          :clickable="true"
          :show-chevron="true"
          @click="openJobDialog()"
        />
      </SettingsGroup>

      <!-- Skills -->
      <SettingsGroup label="SKILLS">
        <SettingsRow
          v-for="skill in cronSkills"
          :key="skill.id"
          :label="skill.name"
          :subtitle="`${(skill.allowedTools || []).length || 'all'} tools · max ${skill.maxTurns || 3} turns · ${skill.model || 'default'}`"
          :clickable="true"
          :show-chevron="true"
          @click="openSkillDialog(skill)"
        />
        <SettingsRow
          label="Add Skill"
          subtitle="Create a constrained skill for heartbeat/cron"
          :clickable="true"
          :show-chevron="true"
          @click="openSkillDialog()"
        />
      </SettingsGroup>

      <!-- Session History -->
      <SettingsGroup label="SESSIONS">
        <SettingsRow
          label="Session History"
          :subtitle="sessionCountLabel"
          :clickable="true"
          :show-chevron="true"
          icon-color="bg-emerald-500/15 text-emerald-400"
          @click="openSessionsDialog"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Clear Conversation -->
      <SettingsGroup>
        <SettingsRow
          label="Clear Conversation"
          subtitle="Resets in-memory state. Session transcripts are preserved."
          :clickable="true"
          :destructive="true"
          @click="confirmClear"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </template>
        </SettingsRow>
      </SettingsGroup>
    </div>

    <!-- API Key Dialog (overlay) -->
    <Teleport to="body">
      <div v-if="showApiKeyDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showApiKeyDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4">
          <div>
            <h3 class="text-base font-semibold text-foreground">API Key</h3>
            <p class="text-xs text-muted-foreground mt-1">Enter your Anthropic API key to use the agent.</p>
          </div>
          <input
            v-model="apiKeyDialogInput"
            type="password"
            placeholder="sk-ant-api03-..."
            class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                   text-sm text-foreground font-mono
                   placeholder:text-muted-foreground/40
                   focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <p
            v-if="apiKeyDialogInput && !apiKeyDialogInput.startsWith('sk-ant-')"
            class="text-xs text-amber-400"
          >
            Anthropic API keys typically start with "sk-ant-"
          </p>
          <div class="flex gap-2 justify-end">
            <button
              @click="showApiKeyDialog = false"
              class="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground
                     border border-border/50 hover:bg-foreground/[0.04] transition-colors"
            >
              Cancel
            </button>
            <button
              @click="saveApiKeyFromDialog"
              :disabled="!apiKeyDialogInput.trim()"
              class="px-4 py-2 rounded-lg text-sm font-medium
                     bg-primary text-primary-foreground hover:bg-primary/90
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Embedding Key Dialog (overlay) -->
    <Teleport to="body">
      <div v-if="showEmbeddingKeyDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showEmbeddingKeyDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4">
          <div>
            <h3 class="text-base font-semibold text-foreground">Embedding API Key</h3>
            <p class="text-xs text-muted-foreground mt-1">
              OpenAI key for text-embedding-3-small. Leave blank to use the local hash fallback (lower quality, fully offline).
            </p>
          </div>
          <input
            v-model="embeddingKeyInput"
            type="password"
            placeholder="sk-..."
            class="w-full px-3 py-2.5 rounded-lg bg-secondary border border-border/50
                   text-sm text-foreground font-mono
                   placeholder:text-muted-foreground/40
                   focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <div class="flex gap-2 justify-end">
            <button
              v-if="hasEmbeddingKey"
              @click="removeEmbeddingKey"
              class="px-4 py-2 rounded-lg text-sm font-medium text-destructive
                     border border-border/50 hover:bg-destructive/10 transition-colors mr-auto"
            >
              Remove
            </button>
            <button
              @click="showEmbeddingKeyDialog = false"
              class="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground
                     border border-border/50 hover:bg-foreground/[0.04] transition-colors"
            >
              Cancel
            </button>
            <button
              @click="saveEmbeddingKey"
              :disabled="!embeddingKeyInput.trim()"
              class="px-4 py-2 rounded-lg text-sm font-medium
                     bg-primary text-primary-foreground hover:bg-primary/90
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Sessions Dialog (overlay) -->
    <Teleport to="body">
      <div v-if="showSessionsDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showSessionsDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-sm max-h-[60vh] overflow-y-auto p-5">
          <h3 class="text-base font-semibold text-foreground mb-4">Session History</h3>
          <div v-if="sessionsLoading" class="py-8 text-center text-muted-foreground text-sm">
            Loading...
          </div>
          <div v-else-if="sessions.length === 0" class="py-8 text-center text-muted-foreground text-sm">
            No sessions yet
          </div>
          <div v-else class="divide-y divide-border/30">
            <div v-for="s in sessions" :key="s.sessionKey" class="py-3">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-foreground truncate">{{ s.sessionKey }}</span>
                <span class="text-xs text-muted-foreground shrink-0 ml-2">{{ formatDate(s.updatedAt) }}</span>
              </div>
              <div v-if="s.totalTokens" class="text-xs text-muted-foreground/60 mt-0.5">
                {{ s.totalTokens.toLocaleString() }} tokens<span v-if="s.model"> &middot; {{ s.model }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Active Hours Dialog -->
    <Teleport to="body">
      <div v-if="showActiveHoursDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showActiveHoursDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4">
          <h3 class="text-base font-semibold text-foreground">Active Hours</h3>
          <div class="space-y-2">
            <label class="text-xs text-muted-foreground">Start</label>
            <input v-model="activeHoursModel.start" type="time" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
          </div>
          <div class="space-y-2">
            <label class="text-xs text-muted-foreground">End</label>
            <input v-model="activeHoursModel.end" type="time" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
          </div>
          <div class="space-y-2">
            <label class="text-xs text-muted-foreground">Timezone</label>
            <input v-model="activeHoursModel.tz" type="text" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
          </div>
          <div class="flex gap-2 justify-end">
            <button class="px-3 py-2 rounded-lg text-xs border border-border/50" @click="clearActiveHoursDialog">Clear</button>
            <button class="px-3 py-2 rounded-lg text-xs border border-border/50" @click="showActiveHoursDialog = false">Cancel</button>
            <button class="px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground" @click="saveActiveHoursDialog">Save</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Job Dialog -->
    <Teleport to="body">
      <div v-if="showJobDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showJobDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-5 space-y-3">
          <h3 class="text-base font-semibold text-foreground">{{ editingJobId ? 'Edit Cron Job' : 'New Cron Job' }}</h3>
          <input v-model="jobDraft.name" placeholder="Job name" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />

          <div class="grid grid-cols-2 gap-2">
            <select v-model="jobDraft.schedule.kind" class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm">
              <option value="every">Every</option>
              <option value="at">At</option>
            </select>
            <input
              v-if="jobDraft.schedule.kind === 'every'"
              v-model.number="jobDraft.schedule.everyMs"
              type="number"
              min="60000"
              step="60000"
              placeholder="Every ms"
              class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm"
            />
            <input
              v-else
              v-model.number="jobDraft.schedule.atMs"
              type="number"
              placeholder="Unix ms"
              class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm"
            />
          </div>

          <select v-model="jobDraft.skillId" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm">
            <option disabled value="">Select skill</option>
            <option v-for="skill in cronSkills" :key="skill.id" :value="skill.id">{{ skill.name }}</option>
          </select>

          <textarea v-model="jobDraft.prompt" rows="4" placeholder="Prompt" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />

          <div class="grid grid-cols-3 gap-2">
            <select v-model="jobDraft.deliveryMode" class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm">
              <option value="notification">Notification</option>
              <option value="webhook">Webhook</option>
              <option value="none">None</option>
            </select>
            <select v-model="jobDraft.sessionTarget" class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm">
              <option value="isolated">Isolated</option>
              <option value="main">Main Session</option>
            </select>
            <select v-model="jobDraft.wakeMode" class="px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm">
              <option value="next-heartbeat">Next heartbeat</option>
              <option value="now">Now</option>
            </select>
          </div>

          <input
            v-if="jobDraft.deliveryMode === 'webhook'"
            v-model="jobDraft.deliveryWebhookUrl"
            placeholder="Webhook URL"
            class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm"
          />

          <button
            class="w-full px-3 py-2 rounded-lg text-xs border border-border/50 text-left"
            @click="activeHoursTarget = 'job'; openActiveHoursDialog(jobDraft.activeHours)"
          >
            {{ jobDraft.activeHours ? `Active: ${jobDraft.activeHours.start}–${jobDraft.activeHours.end}` : 'Set Active Hours' }}
          </button>

          <div class="flex justify-between gap-2 pt-2">
            <button v-if="editingJobId" class="px-3 py-2 rounded-lg text-xs border border-red-500/40 text-red-400" @click="deleteJobFromDialog">Delete</button>
            <button v-if="editingJobId" class="px-3 py-2 rounded-lg text-xs border border-border/50" @click="openRunHistoryDialog({ id: editingJobId, name: jobDraft.name })">Run History</button>
            <button v-if="editingJobId" class="px-3 py-2 rounded-lg text-xs border border-blue-500/40 text-blue-400" @click="runJobNow(editingJobId); showJobDialog = false">Run Now</button>
            <div class="ml-auto flex gap-2">
              <button class="px-3 py-2 rounded-lg text-xs border border-border/50" @click="showJobDialog = false">Cancel</button>
              <button class="px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground" @click="saveJobDialog">Save</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Skill Dialog -->
    <Teleport to="body">
      <div v-if="showSkillDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showSkillDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-5 space-y-3">
          <h3 class="text-base font-semibold text-foreground">{{ editingSkillId ? 'Edit Skill' : 'New Skill' }}</h3>
          <input v-model="skillDraft.name" placeholder="Skill name" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
          <textarea v-model="skillDraft.systemPrompt" rows="4" placeholder="System prompt" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
          <div class="grid grid-cols-3 gap-2">
            <div>
              <label class="text-xs text-muted-foreground mb-1 block">Model</label>
              <input v-model="skillDraft.model" placeholder="Default" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
            </div>
            <div>
              <label class="text-xs text-muted-foreground mb-1 block">Max Turns</label>
              <input v-model.number="skillDraft.maxTurns" type="number" min="1" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
            </div>
            <div>
              <label class="text-xs text-muted-foreground mb-1 block">Timeout (ms)</label>
              <input v-model.number="skillDraft.timeoutMs" type="number" min="1000" step="1000" class="w-full px-3 py-2 rounded-lg bg-secondary border border-border/50 text-sm" />
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground mb-2">Allowed tools (empty = all)</div>
            <div class="grid grid-cols-2 gap-2">
              <label v-for="tool in availableToolNames" :key="tool" class="text-xs flex items-center gap-2">
                <input
                  type="checkbox"
                  :checked="skillDraft.allowedTools.includes(tool)"
                  @change="(e) => {
                    if (e.target.checked) skillDraft.allowedTools = [...skillDraft.allowedTools, tool]
                    else skillDraft.allowedTools = skillDraft.allowedTools.filter((t) => t !== tool)
                  }"
                />
                <span>{{ tool }}</span>
              </label>
            </div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button v-if="editingSkillId" class="px-3 py-2 rounded-lg text-xs border border-red-500/40 text-red-400 mr-auto" @click="deleteSkillFromDialog">Delete</button>
            <button class="px-3 py-2 rounded-lg text-xs border border-border/50" @click="showSkillDialog = false">Cancel</button>
            <button class="px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground" @click="saveSkillDialog">Save</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Run History Dialog -->
    <Teleport to="body">
      <div v-if="showRunHistoryDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="showRunHistoryDialog = false" />
        <div class="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-full max-w-lg max-h-[70vh] overflow-y-auto p-5">
          <h3 class="text-base font-semibold text-foreground mb-4">Run History · {{ runHistoryJobName }}</h3>
          <div v-if="runHistory.length === 0" class="py-6 text-sm text-muted-foreground text-center">No runs yet</div>
          <div v-else class="space-y-2">
            <div v-for="run in runHistory" :key="run.id" class="border border-border/40 rounded-lg px-3 py-2">
              <div class="flex items-center justify-between text-xs">
                <span>{{ new Date(run.startedAt).toLocaleString() }}</span>
                <span
                  class="px-2 py-0.5 rounded-full"
                  :class="run.status === 'ok' ? 'bg-emerald-500/20 text-emerald-300' : run.status === 'error' ? 'bg-red-500/20 text-red-300' : run.status === 'deduped' ? 'bg-amber-500/20 text-amber-300' : 'bg-muted/40 text-muted-foreground'"
                >
                  {{ run.status }}
                </span>
              </div>
              <div v-if="run.error" class="text-xs text-red-300 mt-1">{{ run.error }}</div>
              <div v-else-if="run.responseText" class="text-xs text-muted-foreground mt-1">{{ run.responseText }}</div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useMobileClaw } from '@/composables/useMobileClaw'
import { useMemory } from '@/composables/useMemory'
import { useHeartbeat } from '@/composables/useHeartbeat'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SettingsSwitch from '@/components/settings/SettingsSwitch.vue'
import IosOnboardingBanner from '@/components/IosOnboardingBanner.vue'
import OverdueToast from '@/components/OverdueToast.vue'

const router = useRouter()
const {
  workerReady, nodeVersion,
  readFile, writeFile, updateConfig,
  getAuthStatus, listSessions, clearConversation,
  invokeTool,
} = useMobileClaw()

const {
  memoryCount, indexing, initialized: memoryInitialized,
  updateMemoryConfig, clearMemories, reindex, loadSavedConfig, refreshCount,
} = useMemory()

const {
  schedulerConfig,
  heartbeatConfig,
  cronJobs,
  cronSkills,
  runHistory,
  overdueJobs,
  lastHeartbeatResult,
  showIosOnboarding,
  setScheduler,
  setHeartbeat,
  addJob,
  updateJob,
  removeJob,
  addSkill,
  updateSkill,
  removeSkill,
  loadRunHistory,
  triggerHeartbeat,
  dismissIosOnboarding,
  init: initHeartbeat,
} = useHeartbeat()

// ── Navigation ───────────────────────────────────────────────────────────────

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/chat')
}

// ── API Key ──────────────────────────────────────────────────────────────────

const showApiKeyDialog = ref(false)
const apiKeyDialogInput = ref('')
const hasApiKey = ref(false)
const apiKeyMasked = ref('')

const apiKeyStatus = computed(() => {
  if (!hasApiKey.value) return 'No API key set'
  return apiKeyMasked.value || 'sk-ant-***'
})

async function loadAuthStatus() {
  if (!workerReady.value) return
  try {
    const status = await getAuthStatus()
    hasApiKey.value = status.hasKey
    apiKeyMasked.value = status.masked || ''
  } catch { /* non-fatal */ }
}

async function saveApiKeyFromDialog() {
  await updateConfig({
    action: 'setApiKey',
    provider: 'anthropic',
    apiKey: apiKeyDialogInput.value.trim(),
  })
  apiKeyDialogInput.value = ''
  showApiKeyDialog.value = false
  await loadAuthStatus()
}

// ── Workspace Editor ─────────────────────────────────────────────────────────

const files = [
  { name: 'SOUL.md', label: 'SOUL.md' },
  { name: 'MEMORY.md', label: 'MEMORY.md' },
  { name: 'IDENTITY.md', label: 'IDENTITY.md' },
  { name: 'HEARTBEAT.md', label: 'HEARTBEAT.md' },
]

const activeFile = ref('SOUL.md')
const content = ref('')
const originalContent = ref('')
const dirty = ref(false)
const loadingFile = ref(false)
const saving = ref(false)
const justSaved = ref(false)
const editorRef = ref(null)

const toolbarButtons = [
  { label: 'B', title: 'Bold', prefix: '**', suffix: '**' },
  { label: 'I', title: 'Italic', prefix: '*', suffix: '*' },
  { label: '#', title: 'Heading', prefix: '# ', suffix: '' },
  { label: '-', title: 'List', prefix: '- ', suffix: '' },
]

async function selectFile(file) {
  if (dirty.value && !confirm('You have unsaved changes. Discard?')) return
  activeFile.value = file.name
  await loadFile()
}

async function loadFile() {
  loadingFile.value = true
  dirty.value = false
  justSaved.value = false
  try {
    const result = await readFile(activeFile.value)
    content.value = result.content || ''
    originalContent.value = content.value
  } catch {
    content.value = ''
    originalContent.value = ''
  } finally {
    loadingFile.value = false
  }
}

function onInput() {
  dirty.value = content.value !== originalContent.value
  justSaved.value = false
}

async function save() {
  saving.value = true
  try {
    await writeFile(activeFile.value, content.value)
    originalContent.value = content.value
    dirty.value = false
    justSaved.value = true
    setTimeout(() => { justSaved.value = false }, 2000)
  } finally {
    saving.value = false
  }
}

function revert() {
  content.value = originalContent.value
  dirty.value = false
}

function insertMarkdown(prefix, suffix) {
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.substring(start, end)
  const replacement = prefix + (selected || 'text') + suffix
  content.value = content.value.substring(0, start) + replacement + content.value.substring(end)
  dirty.value = content.value !== originalContent.value
  nextTick(() => {
    el.selectionStart = start + prefix.length
    el.selectionEnd = start + prefix.length + (selected || 'text').length
    el.focus()
  })
}

// ── Session History ──────────────────────────────────────────────────────────

const showSessionsDialog = ref(false)
const sessions = ref([])
const sessionsLoading = ref(false)
const sessionCount = ref(0)

const sessionCountLabel = computed(() => {
  return `${sessionCount.value} session${sessionCount.value !== 1 ? 's' : ''}`
})

async function openSessionsDialog() {
  showSessionsDialog.value = true
  sessionsLoading.value = true
  try {
    const result = await listSessions('main')
    sessions.value = result.sessions || []
    sessionCount.value = sessions.value.length
  } catch {
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString()
}

// ── Clear Conversation ───────────────────────────────────────────────────────

async function confirmClear() {
  if (confirm('Clear conversation? In-memory state will be reset. Session transcripts are preserved.')) {
    await clearConversation()
  }
}

// ── Memory Settings ──────────────────────────────────────────────────────────

const showEmbeddingKeyDialog = ref(false)
const embeddingKeyInput = ref('')
const hasEmbeddingKey = ref(false)
const autoRecall = ref(true)
const autoCapture = ref(true)

const embeddingKeyStatus = computed(() => {
  if (hasEmbeddingKey.value) return 'OpenAI text-embedding-3-small'
  return 'Local hash fallback (offline)'
})

function loadMemorySettings() {
  const config = loadSavedConfig()
  hasEmbeddingKey.value = !!config.openaiApiKey
  autoRecall.value = config.autoRecall !== false
  autoCapture.value = config.autoCapture !== false
}

function saveEmbeddingKey() {
  const key = embeddingKeyInput.value.trim()
  if (!key) return
  updateMemoryConfig({ openaiApiKey: key })
  hasEmbeddingKey.value = true
  embeddingKeyInput.value = ''
  showEmbeddingKeyDialog.value = false
}

function removeEmbeddingKey() {
  updateMemoryConfig({ openaiApiKey: undefined })
  hasEmbeddingKey.value = false
  embeddingKeyInput.value = ''
  showEmbeddingKeyDialog.value = false
}

function toggleAutoRecall() {
  autoRecall.value = !autoRecall.value
  updateMemoryConfig({ autoRecall: autoRecall.value })
}

function toggleAutoCapture() {
  autoCapture.value = !autoCapture.value
  updateMemoryConfig({ autoCapture: autoCapture.value })
}

async function handleReindex() {
  if (!workerReady.value) return
  await reindex(
    (path) => readFile(path),
    (name, args) => invokeTool(name, args),
  )
}

async function confirmClearMemories() {
  if (confirm('Clear all vector memories? File-based memory (MEMORY.md) is preserved.')) {
    await clearMemories()
  }
}

// ── Scheduler / Heartbeat / Cron / Skills ──────────────────────────────────

const heartbeatIntervals = [
  { label: '15m', value: 15 * 60 * 1000 },
  { label: '30m', value: 30 * 60 * 1000 },
  { label: '1h', value: 60 * 60 * 1000 },
  { label: '2h', value: 2 * 60 * 60 * 1000 },
  { label: '4h', value: 4 * 60 * 60 * 1000 },
]

const heartbeatStatusLine = computed(() => {
  const last = lastHeartbeatResult.value
  const next = heartbeatConfig.value?.nextRunAt
  const nextText = next ? new Date(next).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'n/a'
  if (!last) return `Last: n/a · Next: ${nextText}`
  const reason = last.reason || last.status || 'ok'
  const dur = typeof last.durationMs === 'number' ? `${(last.durationMs / 1000).toFixed(1)}s` : '--'
  return `Last: ${reason} (${dur}) · Next: ${nextText}`
})

function formatJobSubtitle(job) {
  const skill = cronSkills.value.find((s) => s.id === job.skillId)
  const schedule = job?.schedule?.kind === 'every'
    ? `Every ${Math.round((job.schedule.everyMs || 0) / 60000)}m`
    : `At ${new Date(job.schedule?.atMs || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  const status = job.lastRunStatus || 'never ran'
  return `${schedule} · skill: ${skill?.name || 'unknown'} · ${status}`
}

const showActiveHoursDialog = ref(false)
const activeHoursTarget = ref('global')
const activeHoursModel = ref({ start: '', end: '', tz: 'UTC' })

function openActiveHoursDialog(target, current) {
  activeHoursTarget.value = target
  activeHoursModel.value = {
    start: current?.start || '',
    end: current?.end || '',
    tz: current?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
  showActiveHoursDialog.value = true
}

async function saveActiveHoursDialog() {
  const patch = activeHoursModel.value.start && activeHoursModel.value.end
    ? {
        start: activeHoursModel.value.start,
        end: activeHoursModel.value.end,
        tz: activeHoursModel.value.tz,
      }
    : null

  if (activeHoursTarget.value === 'global') {
    await setScheduler(
      patch
        ? { globalActiveHours: patch }
        : {
            global_active_hours_start: null,
            global_active_hours_end: null,
            global_active_hours_tz: null,
          },
    )
  } else if (activeHoursTarget.value === 'heartbeat') {
    await setHeartbeat(
      patch
        ? { activeHours: patch }
        : { active_hours_start: null, active_hours_end: null, active_hours_tz: null },
    )
  } else if (activeHoursTarget.value === 'job') {
    jobDraft.value.activeHours = patch || undefined
  }
  showActiveHoursDialog.value = false
}

async function clearActiveHoursDialog() {
  activeHoursModel.value = { start: '', end: '', tz: activeHoursModel.value.tz || 'UTC' }
  await saveActiveHoursDialog()
}

async function toggleSchedulerEnabled() {
  await setScheduler({ enabled: !schedulerConfig.value?.enabled })
}

async function setSchedulingMode(mode) {
  await setScheduler({ schedulingMode: mode })
}

async function toggleRunOnCharging() {
  await setScheduler({ runOnCharging: !schedulerConfig.value?.runOnCharging })
}

async function toggleHeartbeatEnabled() {
  await setHeartbeat({ enabled: !heartbeatConfig.value?.enabled })
}

async function setHeartbeatEvery(ms) {
  await setHeartbeat({ everyMs: ms })
}

async function setHeartbeatSkill(skillId) {
  await setHeartbeat({ skillId: skillId || undefined })
}

const showJobDialog = ref(false)
const editingJobId = ref(null)
const showRunHistoryDialog = ref(false)
const runHistoryJobName = ref('')

function createDefaultJobDraft() {
  return {
    name: '',
    enabled: true,
    sessionTarget: 'isolated',
    wakeMode: 'next-heartbeat',
    schedule: { kind: 'every', everyMs: 60 * 60 * 1000 },
    skillId: '',
    prompt: '',
    deliveryMode: 'notification',
    deliveryWebhookUrl: '',
    deliveryNotificationTitle: '',
    activeHours: undefined,
  }
}

const jobDraft = ref(createDefaultJobDraft())

function openJobDialog(job = null) {
  editingJobId.value = job?.id || null
  jobDraft.value = job
    ? {
        name: job.name,
        enabled: job.enabled !== false,
        sessionTarget: job.sessionTarget || 'isolated',
        wakeMode: job.wakeMode || 'next-heartbeat',
        schedule: { ...job.schedule },
        skillId: job.skillId,
        prompt: job.prompt,
        deliveryMode: job.deliveryMode || 'notification',
        deliveryWebhookUrl: job.deliveryWebhookUrl || '',
        deliveryNotificationTitle: job.deliveryNotificationTitle || '',
        activeHours: job.activeHours,
      }
    : createDefaultJobDraft()
  showJobDialog.value = true
}

async function saveJobDialog() {
  if (!jobDraft.value.name.trim() || !jobDraft.value.skillId || !jobDraft.value.prompt.trim()) return
  if (editingJobId.value) {
    await updateJob(editingJobId.value, { ...jobDraft.value })
  } else {
    await addJob({ ...jobDraft.value })
  }
  showJobDialog.value = false
}

async function deleteJobFromDialog() {
  if (!editingJobId.value) return
  await removeJob(editingJobId.value)
  showJobDialog.value = false
}

const showSkillDialog = ref(false)
const editingSkillId = ref(null)

function createDefaultSkillDraft() {
  return {
    name: '',
    allowedTools: [],
    systemPrompt: '',
    model: 'claude-sonnet-4-5',
    maxTurns: 3,
    timeoutMs: 60000,
  }
}

const skillDraft = ref(createDefaultSkillDraft())
const availableToolNames = ref([
  'read_file',
  'write_file',
  'list_files',
  'grep_files',
  'find_files',
  'edit_file',
  'execute_js',
  'execute_python',
  'git_status',
  'git_diff',
])

function openSkillDialog(skill = null) {
  editingSkillId.value = skill?.id || null
  skillDraft.value = skill
    ? {
        name: skill.name,
        allowedTools: skill.allowedTools || [],
        systemPrompt: skill.systemPrompt || '',
        model: skill.model || 'claude-sonnet-4-5',
        maxTurns: skill.maxTurns || 3,
        timeoutMs: skill.timeoutMs || 60000,
      }
    : createDefaultSkillDraft()
  showSkillDialog.value = true
}

async function saveSkillDialog() {
  if (!skillDraft.value.name.trim()) return
  if (editingSkillId.value) {
    await updateSkill(editingSkillId.value, { ...skillDraft.value })
  } else {
    await addSkill({ ...skillDraft.value })
  }
  showSkillDialog.value = false
}

async function deleteSkillFromDialog() {
  if (!editingSkillId.value) return
  await removeSkill(editingSkillId.value)
  showSkillDialog.value = false
}

async function openRunHistoryDialog(job) {
  runHistoryJobName.value = job.name
  await loadRunHistory(job.id, 50)
  showRunHistoryDialog.value = true
}

// ── Init ─────────────────────────────────────────────────────────────────────

watch(workerReady, (ready) => {
  if (ready) {
    initHeartbeat().catch(() => {})
    loadAuthStatus()
    loadFile()
    loadMemorySettings()
    refreshCount()
  }
}, { immediate: true })
</script>
