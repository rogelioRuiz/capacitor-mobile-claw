import { computed, ref } from 'vue'
import { useMobileClaw } from './useMobileClaw.js'

const schedulerConfig = ref(null)
const heartbeatConfig = ref(null)
const cronJobs = ref([])
const cronSkills = ref([])
const runHistory = ref([])
const overdueJobs = ref([])
const heartbeatStatus = ref('idle')
const lastHeartbeatResult = ref(null)
const iosOnboardingDismissedAt = ref(null)

let initPromise = null

async function init() {
  if (initPromise) return initPromise
  initPromise = _doInit()
  return initPromise
}

async function _doInit() {
  const { engine, onMessage, init: initMobileClaw } = useMobileClaw()
  await initMobileClaw()

  const configResult = await engine.getSchedulerConfig()
  schedulerConfig.value = configResult.scheduler
  heartbeatConfig.value = configResult.heartbeat

  cronJobs.value = await engine.listCronJobs()
  cronSkills.value = await engine.listSkills()

  onMessage('heartbeat.started', () => {
    heartbeatStatus.value = 'running'
  })
  onMessage('heartbeat.completed', (msg) => {
    heartbeatStatus.value = 'completed'
    lastHeartbeatResult.value = msg
  })
  onMessage('heartbeat.skipped', (msg) => {
    heartbeatStatus.value = 'skipped'
    lastHeartbeatResult.value = msg
  })
  onMessage('scheduler.status', (msg) => {
    if (!schedulerConfig.value) return
    schedulerConfig.value = {
      ...schedulerConfig.value,
      enabled: msg.enabled,
      schedulingMode: msg.mode,
    }
    if (typeof msg.nextDueAt === 'number') {
      schedulerConfig.value.nextDueAt = msg.nextDueAt
    }
    if (heartbeatConfig.value && typeof msg.heartbeatNext === 'number') {
      heartbeatConfig.value = {
        ...heartbeatConfig.value,
        nextRunAt: msg.heartbeatNext,
      }
    }
  })
  onMessage('scheduler.overdue', (msg) => {
    const jobs = Array.isArray(msg?.jobs) ? msg.jobs : [msg]
    overdueJobs.value = jobs.filter(Boolean)
  })
  onMessage('cron.job.completed', () => {
    refreshJobs().catch(() => {})
  })
  onMessage('cron.job.error', () => {
    refreshJobs().catch(() => {})
  })

  const dismissed = localStorage.getItem('sentinel-ios-onboarding-dismissed')
  iosOnboardingDismissedAt.value = dismissed ? Number(dismissed) : null
}

async function refreshConfig() {
  const { engine } = useMobileClaw()
  const result = await engine.getSchedulerConfig()
  schedulerConfig.value = result.scheduler
  heartbeatConfig.value = result.heartbeat
}

async function setScheduler(patch) {
  const { engine } = useMobileClaw()
  await engine.setSchedulerConfig(patch)
  await refreshConfig()
  if (patch.enabled === true) {
    localStorage.setItem('sentinel-enabled-at', String(Date.now()))
  }
}

async function setHeartbeat(patch) {
  const { engine } = useMobileClaw()
  await engine.setHeartbeat(patch)
  await refreshConfig()
}

async function addJob(job) {
  const { engine } = useMobileClaw()
  const created = await engine.addCronJob(job)
  await refreshJobs()
  return created
}

async function updateJob(id, patch) {
  const { engine } = useMobileClaw()
  await engine.updateCronJob(id, patch)
  await refreshJobs()
}

async function removeJob(id) {
  const { engine } = useMobileClaw()
  await engine.removeCronJob(id)
  await refreshJobs()
}

async function runJobNow(id) {
  const { engine } = useMobileClaw()
  await engine.runCronJob(id)
  await refreshJobs()
}

async function addSkill(skill) {
  const { engine } = useMobileClaw()
  const created = await engine.addSkill(skill)
  cronSkills.value = await engine.listSkills()
  return created
}

async function updateSkill(id, patch) {
  const { engine } = useMobileClaw()
  await engine.updateSkill(id, patch)
  cronSkills.value = await engine.listSkills()
}

async function removeSkill(id) {
  const { engine } = useMobileClaw()
  await engine.removeSkill(id)
  cronSkills.value = await engine.listSkills()
}

async function refreshJobs() {
  const { engine } = useMobileClaw()
  cronJobs.value = await engine.listCronJobs()
}

async function loadRunHistory(jobId, limit = 50) {
  const { engine } = useMobileClaw()
  runHistory.value = await engine.getCronRunHistory(jobId, limit)
  return runHistory.value
}

async function triggerHeartbeat() {
  const { engine } = useMobileClaw()
  await engine.triggerHeartbeatWake('manual')
}

function dismissIosOnboarding() {
  const now = Date.now()
  iosOnboardingDismissedAt.value = now
  localStorage.setItem('sentinel-ios-onboarding-dismissed', String(now))
}

const isIos = computed(() => /iPad|iPhone|iPod/.test(navigator.userAgent))

const showIosOnboarding = computed(() => {
  if (!isIos.value || !schedulerConfig.value?.enabled) return false
  if (iosOnboardingDismissedAt.value) return false
  const enabledAt = localStorage.getItem('sentinel-enabled-at')
  if (!enabledAt) return false
  return Date.now() - Number(enabledAt) < 7 * 24 * 60 * 60 * 1000
})

export function useHeartbeat() {
  init().catch(() => {})
  return {
    schedulerConfig,
    heartbeatConfig,
    cronJobs,
    cronSkills,
    runHistory,
    overdueJobs,
    heartbeatStatus,
    lastHeartbeatResult,
    showIosOnboarding,
    isIos,
    setScheduler,
    setHeartbeat,
    addJob,
    updateJob,
    removeJob,
    runJobNow,
    addSkill,
    updateSkill,
    removeSkill,
    refreshJobs,
    loadRunHistory,
    triggerHeartbeat,
    dismissIosOnboarding,
    init,
  }
}
