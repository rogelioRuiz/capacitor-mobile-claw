# Mobile Claw

[![npm](https://img.shields.io/npm/v/capacitor-mobile-claw)](https://www.npmjs.com/package/capacitor-mobile-claw)
[![CI](https://github.com/rogelioRuiz/capacitor-mobile-claw/actions/workflows/ci.yml/badge.svg)](https://github.com/rogelioRuiz/capacitor-mobile-claw/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**On-device AI agent engine for mobile apps** — run Claude directly on your phone with file tools, code execution, git, and extensible MCP tool support.

Mobile Claw is a [Capacitor](https://capacitorjs.com/) plugin that embeds a full AI agent runtime on Android and iOS. Two execution modes: a **WebView agent** for instant cold start (agent loop runs in-process) or a **Node.js worker** for full sandboxed tooling. Both talk directly to the Anthropic API — no cloud relay, no proxy. Includes **on-device vector memory** via [LanceDB](https://www.npmjs.com/package/capacitor-lancedb), **background scheduling** via [MobileCron](https://www.npmjs.com/package/capacitor-mobilecron) (WorkManager / BGTaskScheduler), cron jobs with reusable skills, and native streaming HTTP for WebView CORS bypass.

> Built on [OpenClaw](https://github.com/openclaw/openclaw) and the [Pi framework](https://www.npmjs.com/package/@mariozechner/pi-ai) by [Mario Zechner](https://github.com/badlogic). Pi's philosophy of *"what you leave out matters more than what you put in"* — just 4 core tools and a system prompt under 1,000 tokens — is what makes running a capable AI agent on a phone possible at all.

## Try It — Reference App

The fastest way to see Mobile Claw in action is the included reference app — a complete Vue 3 chat UI with streaming, tool approval, session management, and all features wired up.

<p align="center">
  <img src="docs/screenshots/setup.png" width="240" alt="Setup screen — engine ready, auth config" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/chat.png" width="240" alt="Chat — code execution with JavaScript and Python test results" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/settings.png" width="240" alt="Settings — API key, workspace editor, sessions" />
</p>

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Android Studio](https://developer.android.com/studio) (for Android) or [Xcode](https://developer.apple.com/xcode/) (for iOS)
- An Anthropic API key or Claude Max subscription

### Run on Android

```bash
git clone https://github.com/rogelioRuiz/capacitor-mobile-claw.git
cd capacitor-mobile-claw

# Install deps and build the plugin
npm install && npm run build

# Set up the reference app
cd examples/reference-app
npm install

# Add Android platform + apply patches (first time only, idempotent)
npm run setup:android

# Build APK from CLI — no IDE needed
npm run build:android

# Install on connected device
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

> **Requires**: JDK 21+, Android SDK. Set `ANDROID_HOME` and `JAVA_HOME` if not auto-detected.

### Run on iOS

```bash
git clone https://github.com/rogelioRuiz/capacitor-mobile-claw.git
cd capacitor-mobile-claw

npm install && npm run build

cd examples/reference-app
npm install

# Add iOS platform + sync (first time only, idempotent)
npm run setup:ios

# Build for Simulator from CLI — no Xcode interaction needed
npm run build:ios

# Or open in Xcode for device builds
npx cap open ios
```

> **Requires**: Xcode 15+ with iOS SDK. The SQLite SPM patch is applied automatically on `npm install`.

### Running Tests

```bash
# Unit tests (64 tests)
npm test

# Android E2E (111 tests, requires ADB device)
npm run test:android

# iOS E2E (111 tests, requires booted Simulator)
npm run test:ios

# Full suite: unit + Android + iOS (skips unavailable platforms)
npm run test:full
```

Once the app launches, enter your Anthropic API key in settings and start chatting. The agent can read/write files, run code, use git, and call any registered MCP device tools — all on-device.

## How It Works

The agent loop runs directly in the WebView for instant cold start — no waiting for Node.js worker boot. LLM API calls are routed through native HTTP (OkHttp / URLSession) to bypass WebView CORS, with full SSE streaming. Worker tools (file I/O, git, code exec) are transparently proxied via the bridge.

> A **worker agent** mode is also available (`useWebViewAgent` defaults to `false`) — the full agent loop runs inside the embedded Node.js worker for complete isolation. Both modes share the same API.

```
┌──────────────────────────────────────────────────────────┐
│  Your App (Vue, React, Svelte, vanilla JS)                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  MobileClawEngine (useWebViewAgent: true)          │  │
│  │  ┌──────────────┐                                  │  │
│  │  │ Pi Agent     │──── Anthropic API (native HTTP)  │  │
│  │  │ (in WebView) │                                  │  │
│  │  └──────┬───────┘                                  │  │
│  │         │ ToolProxy (bridge IPC)                    │  │
│  │  ┌──────▼───────────────────────────────────────┐   │  │
│  │  │  Node.js Worker (file tools, git, code exec) │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Install in Your Own App

```bash
npm install capacitor-mobile-claw @capacitor/core @capacitor/device @choreruiz/capacitor-node-js @capacitor-community/sqlite
```

If using Vite, add the bundler plugin to `vite.config.js` (stubs Node.js-only transitive deps):

```javascript
import { mobileClawVitePlugin } from 'capacitor-mobile-claw/vite-plugin'

export default defineConfig({
  plugins: [mobileClawVitePlugin(), vue()],
})
```

Then add these scripts to your `package.json`:

```json
{
  "scripts": {
    "setup:worker": "rm -rf public/nodejs-project && mkdir -p public && cp -R node_modules/capacitor-mobile-claw/nodejs-assets/nodejs-project public/nodejs-project && cd public/nodejs-project && npm install --production",
    "postinstall": "npm run setup:worker",
    "cap:sync": "cap sync && cp -R node_modules/@choreruiz/capacitor-node-js/ios/assets/builtin_modules ios/App/App/public/builtin_modules 2>/dev/null; true",
    "cap:build": "npm run setup:worker && vite build && npm run cap:sync"
  }
}
```

And add to your `capacitor.config.ts`:

```typescript
plugins: {
  CapacitorNodeJS: {
    nodeDir: 'nodejs-project',
  },
}
```

Add `public/nodejs-project` to your `.gitignore` — it's generated from the npm package.

### Basic Usage

```typescript
import { MobileClawEngine } from 'capacitor-mobile-claw'

const engine = new MobileClawEngine()

// WebView agent — instant cold start, streaming via native HTTP
await engine.init({ useWebViewAgent: true })

// Listen for streaming text
engine.addListener('agentEvent', (event) => {
  if (event.eventType === 'text_delta') {
    console.log(event.data.text)
  }
})

// Send a message
await engine.sendMessage('What files are in my workspace?')
```

### With Custom MCP Tools

```typescript
import { MobileClawEngine } from 'capacitor-mobile-claw'
import type { DeviceTool } from 'capacitor-mobile-claw/mcp/tools/types'

const myTools: DeviceTool[] = [
  {
    name: 'get_battery',
    description: 'Get current battery level and charging state',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ level: 0.85, charging: true }),
  },
]

const engine = new MobileClawEngine()

await engine.init({
  tools: myTools,
  useWebViewAgent: true,
})
```

### With On-Device Memory

The agent remembers across sessions using [capacitor-lancedb](https://www.npmjs.com/package/capacitor-lancedb) — a Rust-powered vector database running entirely on-device. Memories are stored, deduplicated, and recalled via semantic search. Five built-in tools (`memory_store`, `memory_recall`, `memory_search`, `memory_forget`, `memory_get`) are passed to the agent automatically.

```typescript
import { MemoryManager } from 'capacitor-lancedb'

const memory = new MemoryManager({ dbPath: 'files://agent-memory' })
await memory.init()

const engine = new MobileClawEngine()
const memoryTools = memory.getTools()
await engine.init({ tools: memoryTools, useWebViewAgent: true })

// Agent can now store/recall memories across sessions.
// Auto-recall injects relevant context at turn start.
// Auto-capture extracts facts from agent responses.
```

### With Background Scheduling

[capacitor-mobilecron](https://www.npmjs.com/package/capacitor-mobilecron) enables the agent to wake and run in the background via Android WorkManager and iOS BGTaskScheduler. The engine's scheduler manages heartbeats (periodic check-ins) and cron jobs (recurring tasks).

```typescript
import { MobileCron } from 'capacitor-mobilecron'

const engine = new MobileClawEngine()
await engine.init({ useWebViewAgent: true, mobileCron: MobileCron })

// Enable scheduler + heartbeat (runs every 30 minutes)
await engine.setSchedulerConfig({ enabled: true, schedulingMode: 'balanced' })
await engine.setHeartbeat({ enabled: true, everyMs: 1800000 })

// Listen for heartbeat results
engine.addListener('heartbeatCompleted', (event) => {
  console.log(`Heartbeat: ${event.status} (${event.durationMs}ms)`)
})
```

### With Cron Jobs

```typescript
// Create a skill (reusable prompt + tool constraints)
const skill = await engine.addSkill({
  name: 'daily-summary',
  maxTurns: 3,
  timeoutMs: 60000,
})

// Schedule a recurring cron job
await engine.addCronJob({
  name: 'morning-briefing',
  enabled: true,
  sessionTarget: 'isolated',
  schedule: { kind: 'every', everyMs: 86400000 }, // 24h
  skillId: skill.id,
  prompt: 'Summarize my workspace changes since yesterday',
  deliveryMode: 'notification',
})
```

## Features

- **Instant cold start** — agent loop runs in the WebView, worker tools proxied transparently
- **On-device vector memory** — store, recall, and search memories via [LanceDB](https://www.npmjs.com/package/capacitor-lancedb) with auto-recall context injection and deduplication
- **Background scheduling** — heartbeat check-ins and cron jobs via [MobileCron](https://www.npmjs.com/package/capacitor-mobilecron) (Android WorkManager / iOS BGTaskScheduler)
- **Cron jobs & skills** — recurring agent tasks with reusable skill definitions, run history, and delivery modes
- **Real-time streaming** — text deltas, tool use, and thinking events
- **Multi-turn conversations** — session persistence via native SQLite
- **OAuth PKCE + API key** — sign in with Claude Max or use a direct API key
- **File tools** — sandboxed read/write/edit/find/grep
- **Code execution** — JavaScript (sandbox) + Python (Pyodide/WebAssembly)
- **Git** — clone, commit, push, diff via isomorphic-git
- **MCP device tools** — extensible via Model Context Protocol
- **Tool approval gate** — approve/deny tool executions before they run (120s TTL)
- **Agent steering** — inject follow-up instructions into a running turn
- **Vite plugin** — stubs Node.js-only transitive deps for browser bundling

## API Reference

### MobileClawEngine

| Method | Description |
|--------|-------------|
| `init(options?)` | Start engine. Options: `useWebViewAgent`, `tools`, `mobileCron`, `enableBridge`, `enableStomp` |
| `sendMessage(prompt, agentId?)` | Send a prompt to the agent |
| `stopTurn()` | Cancel the running agent turn |
| `respondToPreExecute(toolCallId, args, deny?)` | Approve/deny a tool execution |
| `steerAgent(text)` | Inject a follow-up instruction |
| `updateConfig(config)` | Update config (auth, model, provider) |
| `exchangeOAuthCode(tokenUrl, body)` | OAuth token exchange via native HTTP |
| `getAuthStatus(provider?)` | Get current auth profile status |
| `getModels(provider?)` | List available models |
| `readFile(path)` / `writeFile(path, content)` | Workspace file operations |
| `listSessions()` / `resumeSession(key)` | Session management |
| `invokeTool(toolName, args?)` | Call a tool directly |
| `addListener(eventName, handler)` | Subscribe to events |

#### Scheduler & Heartbeat

| Method | Description |
|--------|-------------|
| `setSchedulerConfig(config)` | Set scheduler state (enabled, mode, runOnCharging, activeHours) |
| `getSchedulerConfig()` | Read scheduler + heartbeat config |
| `setHeartbeat(config)` | Configure heartbeat (enabled, interval, skillId, prompt) |
| `triggerHeartbeatWake(source?)` | Trigger immediate heartbeat (`manual` bypasses scheduler gate) |

#### Cron Jobs & Skills

| Method | Description |
|--------|-------------|
| `addCronJob(job)` / `updateCronJob(id, patch)` / `removeCronJob(id)` | CRUD for cron jobs |
| `listCronJobs()` / `runCronJob(id)` | List or manually trigger a job |
| `getCronRunHistory(jobId?, limit?)` | Get historical run records |
| `addSkill(skill)` / `updateSkill(id, patch)` / `removeSkill(id)` | CRUD for skills |
| `listSkills()` | List all defined skills |

### Events

| Event | Fired When |
|-------|-----------|
| `agentEvent` | Text delta, tool use, tool result, or thinking update |
| `agentCompleted` | Agent turn finished (includes token usage) |
| `agentError` | Agent execution failed |
| `toolPreExecute` | Agent wants to run a tool (approval gate) |
| `workerReady` | Node.js worker initialized |
| `heartbeatStarted` / `heartbeatCompleted` / `heartbeatSkipped` | Heartbeat lifecycle |
| `cronJobStarted` / `cronJobCompleted` / `cronJobError` | Cron job lifecycle |
| `schedulerStatus` | Scheduler state changed (next run times) |

## Documentation

- [Architecture](docs/architecture.md) — system design and layer breakdown
- [Bridge Protocol](docs/bridge-protocol.md) — UI-to-Worker message reference
- [Creating Device Tools](docs/creating-tools.md) — how to build custom MCP tools

## Related Packages

- [capacitor-mobile-claw-device-tools](https://www.npmjs.com/package/capacitor-mobile-claw-device-tools) — 64+ pre-built device tools (camera, clipboard, sensors, SSH, etc.)
- [capacitor-lancedb](https://www.npmjs.com/package/capacitor-lancedb) — on-device vector database for agent memory
- [capacitor-mobilecron](https://www.npmjs.com/package/capacitor-mobilecron) — native background scheduling (WorkManager / BGTaskScheduler)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and guidelines.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile framework | [Capacitor 8](https://capacitorjs.com/) |
| Agent core | [Pi](https://www.npmjs.com/package/@mariozechner/pi-ai) by Mario Zechner |
| Embedded runtime | [@choreruiz/capacitor-node-js](https://github.com/rogelioRuiz/capacitor-node-js) |
| Tool protocol | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |
| LLM provider | [Anthropic Claude](https://anthropic.com/) |
| Vector memory | [LanceDB](https://lancedb.com/) via [capacitor-lancedb](https://www.npmjs.com/package/capacitor-lancedb) (Rust FFI, on-device) |
| Background scheduling | [capacitor-mobilecron](https://www.npmjs.com/package/capacitor-mobilecron) (WorkManager / BGTaskScheduler) |
| Git | [isomorphic-git](https://isomorphic-git.org/) |
| Database | [@capacitor-community/sqlite](https://github.com/nicepkg/capacitor-community-sqlite) (native SQLite) |
| Python | [Pyodide](https://pyodide.org/) (CPython via WebAssembly) |
| Type system | TypeScript (strict mode) |
| Lint | [Biome](https://biomejs.dev/) |
| Tests | [Vitest](https://vitest.dev/) (64 unit) + Sentinel E2E (111 on-device) |

## Acknowledgments

Mobile Claw is built on [OpenClaw](https://github.com/openclaw/openclaw) and the [Pi framework](https://www.npmjs.com/package/@mariozechner/pi-ai) by [Mario Zechner](https://github.com/badlogic) (creator of [libGDX](https://libgdx.com/)). Pi demonstrated that a truly capable AI agent doesn't need a massive framework — just four well-designed tools and a focused system prompt. That minimalism is what makes on-device mobile execution feasible.

## License

MIT
