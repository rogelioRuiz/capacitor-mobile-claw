declare module 'capacitor-mobilecron' {
  export interface MobileCronJobDueEvent {
    source?: string
    firedAt?: number
    [key: string]: unknown
  }

  export interface MobileCronPlugin {
    register(options: {
      name: string
      schedule: { kind: 'every' | 'at'; everyMs?: number; atMs?: number }
      activeHours?: { start: string; end: string; tz?: string }
      priority?: 'low' | 'normal' | 'high'
      requiresNetwork?: boolean
    }): Promise<void>
    setMode(options: { mode: 'eco' | 'balanced' | 'aggressive' | string }): Promise<void>
    addListener(
      eventName: 'jobDue' | 'overdueJobs',
      listenerFunc: (event: MobileCronJobDueEvent) => void,
    ): Promise<{ remove: () => Promise<void> }>
  }

  export const MobileCron: MobileCronPlugin
}
