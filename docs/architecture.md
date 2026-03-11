# Architecture

## Overview

Mobile Claw is a Capacitor plugin that provides a thin WebView bridge to a **native Rust AI agent** ([capacitor-native-agent](https://www.npmjs.com/package/capacitor-native-agent)). All agent logic — LLM streaming, tool execution, auth, sessions, cron/heartbeat — runs natively via UniFFI. The WebView layer handles only UI rendering, event display, and MCP device tool coordination.

```
┌──────────────────────────────────────────────────────┐
│  Your App (Vue, React, Svelte, vanilla JS)            │
│  ┌────────────────────────────────────────────────┐  │
│  │  MobileClawEngine (thin event bridge)          │  │
│  │         │ Capacitor Bridge                      │  │
│  │  ┌──────▼──────────────────────────────────┐   │  │
│  │  │  Native Rust Agent (capacitor-native-agent) │  │
│  │  │  LLM · Tools · Auth · Sessions · Cron   │  │
│  │  │         │── Anthropic API (native HTTP)  │  │
│  │  └─────────────────────────────────────────┘   │  │
│  │  ┌─────────────────────────────────────────┐   │  │
│  │  │  MCP Device Tools (WebView JS)           │   │  │
│  │  └─────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Layer Breakdown

### Native Agent (`capacitor-native-agent`)
The Rust native agent owns all core logic:
- **Agent loop** — LLM streaming and turn management
- **Tool execution** — file tools, git, code execution, SQLite
- **Auth store** — API key and OAuth PKCE token management
- **Session store** — multi-turn conversation persistence
- **Scheduler** — cron job evaluation, heartbeat lifecycle
- **Native HTTP** — OkHttp (Android) / URLSession (iOS) for LLM API calls, bypassing WebView CORS

### UI Layer (`src/engine.ts`)
The `MobileClawEngine` class is a thin event bridge. It is framework-agnostic — no Vue, React, or other UI framework dependency. It handles:
- Event dispatch (local listeners for UI rendering)
- MCP server management (device tools that need WebView Capacitor APIs)
- MobileCron registration (native wake timer scheduling)
- OAuth code exchange (CapacitorHttp)

### MCP Subsystem (`src/mcp/`)
Model Context Protocol implementation for extensible device tools:
- **`mcp-server-manager.ts`** — Lifecycle management for MCP server instances
- **`device-mcp-server.ts`** — MCP server that exposes registered `DeviceTool` implementations
- **`bridge-server-transport.ts`** — In-process IPC transport (default, zero latency)
- **`stomp-server-transport.ts`** — WebSocket transport for remote MCP access
- **`transport-manager.ts`** — Coordinates multiple transports concurrently

## Key Design Decisions

1. **Native Rust agent** — All agent logic runs natively for performance and reliability. The WebView is purely a presentation layer.
2. **No cloud relay** — The only network call is from the device to the Anthropic API. No intermediate servers.
3. **Thin bridge** — `MobileClawEngine` delegates everything to the native plugin. MCP device tools that need WebView Capacitor APIs (camera, sensors, etc.) are the only JS-side logic.
4. **MCP for device tools** — Standard protocol means tools written for desktop MCP clients work on mobile with minimal adaptation.
5. **UniFFI bindings** — Rust code is exposed to Kotlin (Android) and Swift (iOS) via UniFFI, with the Capacitor bridge providing the final hop to JavaScript.
