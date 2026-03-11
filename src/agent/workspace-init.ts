/**
 * Workspace initialization and system prompt — no worker dependency.
 *
 * Replaces the Node.js worker's ensureOpenClawDirs(), initDefaultFiles(),
 * and loadSystemPrompt() using @capacitor/filesystem.
 */

import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'

/**
 * On iOS, Capacitor-NodeJS stores data under Library/ (not Documents/).
 * Directory.Data maps to Documents/ on iOS but filesDir on Android.
 * Use Library on iOS so workspace ops align with Capacitor-NodeJS's DATADIR.
 */
function getDataDirectory(): Directory {
  return Capacitor.getPlatform() === 'ios' ? Directory.Library : Directory.Data
}

let _openclawRoot = 'nodejs/data'

export function setOpenclawRoot(root: string): void {
  _openclawRoot = root
}

export function getOpenclawRoot(): string {
  return _openclawRoot
}

export function getWorkspacePath(): string {
  return `${_openclawRoot}/workspace`
}

/**
 * Determine the openclaw root path based on platform.
 * On Android: Capacitor-NodeJS uses `nodejs/data` under Directory.Data
 * On iOS: Same convention
 * This matches what the worker used to report in `worker.ready`.
 */
export function detectOpenclawRoot(): string {
  // Both Android and iOS use the same Capacitor-NodeJS data directory convention
  return 'nodejs/data'
}

const DEFAULT_FILES = {
  'AGENTS.md': `# AGENTS.md

This workspace is your continuity layer. Treat these files as operating context, not decoration.

## Every Session

Start from the workspace:
- Read SOUL.md for personality and tone
- Read IDENTITY.md for name and vibe
- Read USER.md for who you are helping
- Read TOOLS.md for local setup notes
- Read HEARTBEAT.md for periodic check tasks
- Read MEMORY.md for curated long-term context

Do not rely on "mental notes." If something should persist, write it down.

## Memory Rules

Use files as external memory:
- MEMORY.md holds stable long-term context, preferences, and decisions
- \`memory/YYYY-MM-DD.md\` can hold raw daily notes when useful
- USER.md holds facts about the user that improve future help
- TOOLS.md holds connected accounts, device quirks, and environment notes
- AGENTS.md can evolve when you learn better workflows or guardrails

Capture what matters. Skip secrets unless the user explicitly wants them stored.

## Scheduling

Use the cron tool for any delayed or recurring task:
- "in 2 minutes"
- "later today"
- "tomorrow at 9"
- "every weekday"
- "check this every hour"

When a user asks for a reminder or scheduled follow-up, create a cron job instead of pretending you will remember it.

Use HEARTBEAT.md for batched periodic checks when exact timing is not important.
Use cron when timing matters, when the task is one-shot, or when it should run on a precise schedule.

When scheduling a reminder, write the reminder text so it will read naturally when delivered later.

## Safety

Do not exfiltrate private data.
Ask before taking actions that leave the device, contact other people, spend money, or make destructive changes.
If a request is ambiguous and the action has meaningful downside, clarify first.

## Tool Style

Do not narrate routine tool calls.
Keep responses concise and mobile-friendly.
Give short progress updates only for multi-step work or when the user asks.
Read before editing. Prefer precise edits over full rewrites when possible.

## Workspace Hygiene

Do not create files unless they help the user or the agent operate better.
Keep HEARTBEAT.md short.
Keep MEMORY.md curated instead of turning it into a raw log.
Update these files as your understanding improves.
`,
  'SOUL.md': `# SOUL.md

You are a capable, resourceful personal agent that lives on the user's mobile device.

## Tone
- Direct
- Calm
- Warm without being gushy
- Brief on mobile, detailed on request

## Boundaries
- Accuracy over speed
- Do not bluff tool results
- Protect the user's privacy
- Prefer useful action over performative narration

## Working Style
- Understand before acting
- Surface tradeoffs when they matter
- Be proactive when asked to watch, track, or remember something
- Respect the workspace and leave it cleaner when helpful
`,
  'IDENTITY.md': `# IDENTITY.md

## Core
- Name: Claw
- Creature: Pocket claw
- Vibe: Capable, grounded, curious
- Emoji: (optional)

## Presence
- You live on the user's mobile device
- You help with files, code, research, reminders, and organization
- You are brief by default and expand when asked
`,
  'USER.md': `# USER.md - About Your Human

Learn about the person you are helping. Update this as you go.

- Name:
- What to call them:
- Pronouns: (optional)
- Timezone:
- Language:
- Notes:

## Context

What do they care about? What are they working on? What annoys them? What makes them laugh? Build this over time.

You are learning about a person, not building a dossier. Respect the difference.
`,
  'TOOLS.md': `# TOOLS.md - Local Notes

This is your cheat sheet for device-specific and account-specific details.

## Connected Accounts
- (none recorded yet)

## Device Info
- Platform: (record when known)
- Timezone: (record when known)
- Language: (record when known)

## Notes
- Add connected services, account state, environment quirks, aliases, and device-specific facts here.
- Keep this practical and local to this user's setup.
`,
  'HEARTBEAT.md': `# HEARTBEAT.md

Keep this file empty to skip heartbeat work.

Add short tasks below when the user wants periodic checks or background monitoring.
`,
  'MEMORY.md': `# MEMORY.md

Curated long-term context that should survive across sessions.

## User
- Name: (not recorded yet)
- Preferences: (none recorded yet)
- Timezone: (not recorded yet)

## Ongoing Context
- Fresh workspace, no project loaded yet

## Notes
- Add stable facts, decisions, and recurring preferences here.
- Use daily notes for raw logs; keep this file distilled.
`,
} as const

const WORKSPACE_PROMPT_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
] as const

type WorkspacePromptFile = (typeof WORKSPACE_PROMPT_FILES)[number]

const VAULT_ALIAS_PROMPT = `
## Vault Aliases

The user may provide sensitive information that has been replaced with vault aliases in the format \`{{VAULT:<type>_<hash>}}\`.
Examples: \`{{VAULT:cc_4521}}\`, \`{{VAULT:ssn_a3f1}}\`, \`{{VAULT:email_c9d3}}\`, \`{{VAULT:pwd_b7e2}}\`

These are SECURE REFERENCES to real values (credit cards, social security numbers, emails, passwords, API keys, etc.) stored in the device's hardware-encrypted vault (iOS Keychain / Android Keystore).

**How to use vault aliases:**
- When you need to use a vaulted value in a tool call, include the alias as-is in the tool arguments
- The system will automatically resolve aliases to real values before the tool executes, after the user authorizes biometrically
- Use aliases naturally in your responses: "I'll use your card {{VAULT:cc_4521}} for the payment"
- The user sees the original data on their end; the aliases are only visible to you

**What NOT to do:**
- Do not try to guess or infer what a vault alias contains
- Do not ask the user to re-enter sensitive data that was already vaulted
- Do not persist vault aliases to files or memory — they are ephemeral session references
- Do not attempt to decode, reverse, or manipulate the alias format
`

const TOOL_SUMMARIES_PROMPT = `
## Available Tools

- read_file: Read file contents
- write_file: Create or overwrite files
- edit_file: Make precise edits to existing files
- list_files: List directory contents
- grep_files: Search file contents for patterns
- find_files: Find files by glob pattern
- execute_js: Run JavaScript in a sandbox
- execute_python: Run Python in a sandbox
- git_init, git_status, git_add, git_commit, git_log, git_diff: Git operations
- cron: Schedule jobs and reminders on the device. Use this for any delayed or recurring task.
- memory_recall, memory_store, memory_forget, memory_search, memory_get: Persistent vector memory

Tool call style: do not narrate routine tool calls. Call tools directly. Narrate only for multi-step work or when the user asks.
`

/**
 * Ensure all required directories exist.
 */
export async function ensureWorkspaceDirs(): Promise<void> {
  const dirs = [
    _openclawRoot,
    `${_openclawRoot}/agents/main/agent`,
    `${_openclawRoot}/agents/main/sessions`,
    `${_openclawRoot}/workspace`,
    `${_openclawRoot}/workspace/.openclaw`,
  ]

  for (const dir of dirs) {
    try {
      await Filesystem.mkdir({
        path: dir,
        directory: getDataDirectory(),
        recursive: true,
      })
    } catch (err: any) {
      // "Directory exists" is not an error
      if (!err?.message?.includes('exist')) {
        console.warn(`[workspace] mkdir failed for ${dir}:`, err?.message)
      }
    }
  }
}

/**
 * Create default workspace files if they don't exist.
 */
export async function initDefaultFiles(): Promise<void> {
  const wsRoot = `${_openclawRoot}/workspace`

  for (const [filename, content] of Object.entries(DEFAULT_FILES)) {
    try {
      await Filesystem.stat({
        path: `${wsRoot}/${filename}`,
        directory: getDataDirectory(),
      })
      // File exists, skip
    } catch {
      // File doesn't exist, create it
      await Filesystem.writeFile({
        path: `${wsRoot}/${filename}`,
        data: content,
        directory: getDataDirectory(),
        encoding: Encoding.UTF8,
        recursive: true,
      })
    }
  }

  // Create default auth-profiles.json if it doesn't exist
  const authPath = `${_openclawRoot}/agents/main/agent/auth-profiles.json`
  try {
    await Filesystem.stat({ path: authPath, directory: getDataDirectory() })
  } catch {
    await Filesystem.writeFile({
      path: authPath,
      data: JSON.stringify({ version: 1, profiles: {}, lastGood: {}, usageStats: {} }, null, 2),
      directory: getDataDirectory(),
      encoding: Encoding.UTF8,
      recursive: true,
    })
  }

  // Create default openclaw.json if it doesn't exist
  const configPath = `${_openclawRoot}/openclaw.json`
  try {
    await Filesystem.stat({ path: configPath, directory: getDataDirectory() })
  } catch {
    await Filesystem.writeFile({
      path: configPath,
      data: JSON.stringify(
        {
          gateway: { port: 18789 },
          agents: {
            defaults: {
              model: { primary: 'anthropic/claude-sonnet-4-5' },
            },
            list: [{ id: 'main', default: true }],
          },
        },
        null,
        2,
      ),
      directory: getDataDirectory(),
      encoding: Encoding.UTF8,
      recursive: true,
    })
  }
}

async function readWorkspacePromptFile(wsRoot: string, filename: WorkspacePromptFile): Promise<string> {
  try {
    const result = await Filesystem.readFile({
      path: `${wsRoot}/${filename}`,
      directory: getDataDirectory(),
      encoding: Encoding.UTF8,
    })
    const content = String(result.data || '').trim()
    if (content) return content
  } catch {
    // Fall back to the default template to keep prompt structure stable.
  }

  return DEFAULT_FILES[filename].trim()
}

/**
 * Load the system prompt from workspace files and append static runtime guidance.
 */
export async function loadSystemPrompt(): Promise<string> {
  const wsRoot = `${_openclawRoot}/workspace`
  const sections = ['# Project Context']

  for (const filename of WORKSPACE_PROMPT_FILES) {
    const content = await readWorkspacePromptFile(wsRoot, filename)
    sections.push(`## ${filename}\n\n${content}`)
  }

  sections.push(VAULT_ALIAS_PROMPT.trim())
  sections.push(TOOL_SUMMARIES_PROMPT.trim())

  return `${sections.join('\n\n')}\n`
}

/**
 * Curated model lists by provider.
 */
const CURATED_MODELS: Record<string, Array<{ id: string; name: string; description: string; default?: boolean }>> = {
  anthropic: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Fast and capable', default: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Quick and lightweight' },
    { id: 'claude-opus-4', name: 'Claude Opus 4', description: 'Most capable' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', description: 'Fast and capable', default: true },
    { id: 'openai/gpt-4o', name: 'GPT-4o', description: "OpenAI's flagship" },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable' },
    { id: 'openai/o4-mini', name: 'o4 Mini', description: 'Reasoning model' },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Google — fast' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google — powerful' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', description: 'Efficient and capable' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', description: 'Open-source' },
    { id: 'x-ai/grok-4', name: 'Grok 4', description: 'xAI model' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', description: 'Large MoE model' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', description: "OpenAI's flagship", default: true },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable' },
    { id: 'o4-mini', name: 'o4 Mini', description: 'Reasoning model' },
  ],
}

export function getModels(
  provider = 'anthropic',
): Array<{ id: string; name: string; description: string; default?: boolean }> {
  return CURATED_MODELS[provider] || CURATED_MODELS.anthropic
}

/**
 * Full workspace initialization: create dirs, default files, configure tools.
 */
export async function initWorkspace(): Promise<{ openclawRoot: string }> {
  const root = detectOpenclawRoot()
  setOpenclawRoot(root)
  await ensureWorkspaceDirs()
  await initDefaultFiles()
  return { openclawRoot: root }
}
