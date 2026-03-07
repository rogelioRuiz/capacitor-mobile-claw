# Architecture

## Overview

Mobile Claw is a Capacitor plugin that embeds a full AI agent runtime on Android and iOS. The agent loop runs directly in the WebView for instant cold start. LLM API calls are routed through native HTTP (OkHttp / URLSession) to bypass WebView CORS, with full SSE streaming.

```
┌──────────────────────────────────────────────────────┐
│  Your App (Vue, React, Svelte, vanilla JS)            │
│  ┌────────────────────────────────────────────────┐  │
│  │  MobileClawEngine                              │  │
│  │  ┌──────────────┐                              │  │
│  │  │ Pi Agent     │── Anthropic API (native HTTP)│  │
│  │  │ (in WebView) │                              │  │
│  │  └──────┬───────┘                              │  │
│  │         │ Capacitor Bridge                      │  │
│  │  ┌──────▼──────────────────────────────────┐   │  │
│  │  │  File tools · Git · Code exec · SQLite  │   │  │
│  │  └─────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Layer Breakdown

### UI Layer (`src/engine.ts`)
The `MobileClawEngine` class is the public API. It is framework-agnostic — no Vue, React, or other UI framework dependency. It manages:
- Agent lifecycle (init, ready detection, timeouts)
- Bridge message send/receive
- MCP server management
- Event listener subscriptions

### Bridge Protocol (`src/services/bridge-protocol.ts`)
Typed message definitions for communication between the engine and native plugins. Messages are JSON-serialized and passed via the Capacitor bridge.

### MCP Subsystem (`src/mcp/`)
Model Context Protocol implementation for extensible device tools:
- **`mcp-server-manager.ts`** — Lifecycle management for MCP server instances
- **`device-mcp-server.ts`** — MCP server that exposes registered `DeviceTool` implementations
- **`bridge-server-transport.ts`** — In-process IPC transport (default, zero latency)
- **`stomp-server-transport.ts`** — WebSocket transport for remote MCP access
- **`transport-manager.ts`** — Coordinates multiple transports concurrently

## Key Design Decisions

1. **No cloud relay** — The only network call is from the device to the Anthropic API. No intermediate servers.
2. **WebView agent loop** — The agent runs directly in the WebView for instant cold start. No embedded Node.js worker process.
3. **Native HTTP bypass** — OkHttp (Android) and URLSession (iOS) route LLM API calls through native code to bypass WebView CORS restrictions, with full SSE streaming support.
4. **MCP for device tools** — Standard protocol means tools written for desktop MCP clients work on mobile with minimal adaptation.
5. **Pi framework as agent core** — Minimal, proven engine (4 core tools, <1000 token system prompt) that's lightweight enough for mobile.
