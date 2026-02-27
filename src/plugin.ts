/**
 * MobileClaw Capacitor Plugin — Plugin class implementation.
 *
 * Wraps MobileClawEngine in the Capacitor WebPlugin interface.
 * This is the bridge between Capacitor's addListener/removeAllListeners
 * pattern and the engine's event system.
 */

import { WebPlugin } from '@capacitor/core'
import type {
  AuthStatus,
  CronJobInput,
  CronJobRecord,
  CronRunRecord,
  CronSkillInput,
  CronSkillRecord,
  FileReadResult,
  HeartbeatConfig,
  MobileClawEvent,
  MobileClawEventName,
  MobileClawInitOptions,
  MobileClawPlugin,
  MobileClawReadyInfo,
  SchedulerConfig,
  SessionHistoryResult,
  SessionInfo,
  SessionListResult,
  ToolInvokeResult,
} from './definitions'
import { MobileClawEngine } from './engine'

export class MobileClawWeb extends WebPlugin implements MobileClawPlugin {
  private engine = new MobileClawEngine()

  async init(options?: MobileClawInitOptions): Promise<MobileClawReadyInfo> {
    return this.engine.init(options)
  }

  async isReady(): Promise<{ ready: boolean }> {
    return this.engine.isReady()
  }

  async sendMessage(options: { prompt: string; agentId?: string }): Promise<{ sessionKey: string }> {
    return this.engine.sendMessage(options.prompt, options.agentId)
  }

  async stopTurn(): Promise<void> {
    return this.engine.stopTurn()
  }

  async steerAgent(options: { text: string }): Promise<void> {
    return this.engine.steerAgent(options.text)
  }

  async updateConfig(options: { config: Record<string, unknown> }): Promise<void> {
    return this.engine.updateConfig(options.config)
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return this.engine.getAuthStatus()
  }

  async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
    return this.engine.setSchedulerConfig(config)
  }

  async getSchedulerConfig(): Promise<{ scheduler: SchedulerConfig; heartbeat: HeartbeatConfig }> {
    return this.engine.getSchedulerConfig()
  }

  async setHeartbeat(config: Partial<HeartbeatConfig>): Promise<void> {
    return this.engine.setHeartbeat(config)
  }

  async triggerHeartbeatWake(source?: string): Promise<void> {
    return this.engine.triggerHeartbeatWake(source)
  }

  async addCronJob(job: CronJobInput): Promise<CronJobRecord> {
    return this.engine.addCronJob(job)
  }

  async updateCronJob(id: string, patch: Partial<CronJobInput>): Promise<void> {
    return this.engine.updateCronJob(id, patch)
  }

  async removeCronJob(id: string): Promise<void> {
    return this.engine.removeCronJob(id)
  }

  async listCronJobs(): Promise<CronJobRecord[]> {
    return this.engine.listCronJobs()
  }

  async runCronJob(id: string): Promise<void> {
    return this.engine.runCronJob(id)
  }

  async getCronRunHistory(jobId?: string, limit?: number): Promise<CronRunRecord[]> {
    return this.engine.getCronRunHistory(jobId, limit)
  }

  async addSkill(skill: CronSkillInput): Promise<CronSkillRecord> {
    return this.engine.addSkill(skill)
  }

  async updateSkill(id: string, patch: Partial<CronSkillInput>): Promise<void> {
    return this.engine.updateSkill(id, patch)
  }

  async removeSkill(id: string): Promise<void> {
    return this.engine.removeSkill(id)
  }

  async listSkills(): Promise<CronSkillRecord[]> {
    return this.engine.listSkills()
  }

  async readFile(options: { path: string }): Promise<FileReadResult> {
    return this.engine.readFile(options.path)
  }

  async writeFile(options: { path: string; content: string }): Promise<void> {
    return this.engine.writeFile(options.path, options.content)
  }

  async listSessions(options?: { agentId?: string }): Promise<SessionListResult> {
    return this.engine.listSessions(options?.agentId)
  }

  async getLatestSession(options?: { agentId?: string }): Promise<SessionInfo | null> {
    return this.engine.getLatestSession(options?.agentId)
  }

  async loadSessionHistory(options: { sessionKey: string; agentId?: string }): Promise<SessionHistoryResult> {
    return this.engine.loadSessionHistory(options.sessionKey, options.agentId)
  }

  async resumeSession(options: { sessionKey: string; agentId?: string }): Promise<void> {
    return this.engine.resumeSession(options.sessionKey, options.agentId)
  }

  async clearConversation(): Promise<{ success: boolean }> {
    return this.engine.clearConversation()
  }

  async setSessionKey(options: { sessionKey: string }): Promise<void> {
    return this.engine.setSessionKey(options.sessionKey)
  }

  async getSessionKey(): Promise<{ sessionKey: string | null }> {
    return this.engine.getSessionKey()
  }

  async invokeTool(options: { toolName: string; args?: Record<string, unknown> }): Promise<ToolInvokeResult> {
    return this.engine.invokeTool(options.toolName, options.args)
  }

  override async addListener(
    eventName: MobileClawEventName,
    handler: (event: MobileClawEvent) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const { remove } = this.engine.addListener(eventName, handler)
    return { remove: async () => remove() }
  }

  override async removeAllListeners(eventName?: MobileClawEventName): Promise<void> {
    this.engine.removeAllListeners(eventName)
  }

  /**
   * Low-level access to the engine for framework wrappers.
   * Useful for Vue/React integrations that need raw bridge message access.
   */
  getEngine(): MobileClawEngine {
    return this.engine
  }
}
