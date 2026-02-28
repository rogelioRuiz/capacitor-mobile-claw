/**
 * mobile-claw Node.js worker entry point.
 *
 * Runs inside the embedded Node.js runtime provided by Capacitor-NodeJS.
 * Communicates with the Capacitor WebView UI via the bridge channel.
 *
 * The agent loop (LLM streaming + orchestration) runs in the WebView via
 * AgentRunner. This worker provides tool execution proxied from the WebView,
 * plus skill/heartbeat agents that run independently in the background.
 *
 * Responsibilities:
 * - Tool execution proxy (tool.execute → file/git/exec tools → tool.execute.result)
 * - File tools (read/write/edit/find/grep/ls)
 * - Code execution (JS VM sandbox + Python Pyodide sandbox)
 * - Git tools (isomorphic-git)
 * - Skill agent runs (setup, etc. — independent Agent instances)
 * - Heartbeat / cron agent runs (background Agent instances)
 * - Pre-execution hook for skill/heartbeat tools (tool.pre_execute)
 * - Session persistence (native SQLite via bridge)
 * - Auth profile management (auth-profiles.json)
 * - System prompt loading (IDENTITY.md, SOUL.md, MEMORY.md)
 */

// ── DEBUG: Global crash catchers (iOS only shows console.error) ──────────
// Must be BEFORE any imports so we catch errors during module evaluation.
process.on('uncaughtException', (err) => {
  console.error(`[DEBUG] UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack || '(no stack)');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  // Don't log WASM-related rejections (handled by fetch-polyfill)
  if (msg.includes('WASM disabled') || msg.includes('WebAssembly')) return;
  console.error(`[DEBUG] UNHANDLED REJECTION: ${msg}`);
  if (reason?.stack) console.error(reason.stack);
});

// ── fetch() polyfill — MUST be first import ─────────────────────────────
// Replaces the broken undici-based built-in fetch (requires WebAssembly)
// with a native https/http implementation. Being a separate module imported
// first ensures globalThis.fetch is replaced before any dependency evaluates.
import './fetch-polyfill.js';

// ── Node.js v18 polyfills (Capacitor-NodeJS ships v18.20.4) ──────────────
// Anthropic SDK expects globals that only exist in Node.js >=20.
import { Blob } from 'node:buffer';
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    #name; #lastModified;
    constructor(bits, name, opts = {}) {
      super(bits, opts);
      this.#name = name;
      this.#lastModified = opts.lastModified ?? Date.now();
    }
    get name() { return this.#name; }
    get lastModified() { return this.#lastModified; }
  };
}
if (typeof globalThis.FormData === 'undefined') {
  // Minimal FormData polyfill — undici needs it at module load time
  const entries = Symbol('entries');
  globalThis.FormData = class FormData {
    constructor() { this[entries] = []; }
    append(k, v, f) { this[entries].push([k, v, f]); }
    get(k) { const e = this[entries].find(([n]) => n === k); return e ? e[1] : null; }
    getAll(k) { return this[entries].filter(([n]) => n === k).map(e => e[1]); }
    has(k) { return this[entries].some(([n]) => n === k); }
    delete(k) { this[entries] = this[entries].filter(([n]) => n !== k); }
    *[Symbol.iterator]() { yield* this[entries]; }
    forEach(cb) { this[entries].forEach(([k, v]) => cb(v, k, this)); }
  };
}

// bridge is a builtin module injected by Capacitor-NodeJS via NODE_PATH.
// ESM resolution ignores NODE_PATH (Node.js v18), so use createRequire to load it.
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { channel } = _require('bridge');
console.error(`[DEBUG] Bridge channel loaded OK`);

import { resolve, join } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';

// ── SQLite persistence layer (native bridge) ────────────────────────────────
import {
  initWorkerDb, isDbReady,
  query as dbQuery, queryOne as dbQueryOne,
  transaction as dbTransaction,
  getSchedulerConfig, setSchedulerConfig,
  getHeartbeatConfig, setHeartbeatConfig,
  addCronSkill, updateCronSkill, removeCronSkill, listCronSkills,
  addCronJob, updateCronJob, removeCronJob, listCronJobs,
  listCronRuns,
  migrateFromJsonl, atomicWrite,
} from './worker-db.js';

// ── MCP bridge (device tools from WebView) ────────────────────────────────
import { initMcpBridge } from './mcp-bridge-client.js';
import { buildMcpAgentTools } from './mcp-agent-tools.js';
import { initHeartbeat, handleHeartbeatWake } from './worker-heartbeat.js';

const mcpBridge = initMcpBridge(channel);
console.error(`[DEBUG] MCP bridge initialized`);

// Cache for discovered MCP tools — avoids re-discovery on every agent run
let cachedMcpTools = null;
let discoveryPromise = null;
// Epoch incremented on invalidation — prevents a stale in-flight discovery
// from overwriting the cache after mcp.tools.invalidate fires.
let discoveryEpoch = 0;

/**
 * Discover MCP device tools from the WebView server.
 * Returns AgentTool[] or empty array if bridge is not available.
 * Uses a 10-second timeout for graceful degradation.
 * Concurrent callers share the same in-flight promise (no duplicate timeouts).
 */
async function discoverMcpTools() {
  if (cachedMcpTools) return cachedMcpTools;
  if (discoveryPromise) return discoveryPromise;

  const epoch = discoveryEpoch; // Capture epoch before async work

  discoveryPromise = (async () => {
    try {
      const mcpToolDescriptors = await Promise.race([
        mcpBridge.listTools(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);

      const rawTools = buildMcpAgentTools(mcpBridge, mcpToolDescriptors);

      // Only cache if the epoch hasn't changed (no invalidation while discovering)
      if (epoch === discoveryEpoch) {
        cachedMcpTools = rawTools;
        console.log(`[mobile-claw] Discovered ${cachedMcpTools.length} MCP device tools`);
      }

      return cachedMcpTools ?? [];
    } catch (err) {
      console.warn(`[mobile-claw] MCP bridge not available, using local tools only: ${err.message}`);
      return [];
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}

// ── OpenClaw filesystem paths ─────────────────────────────────────────────

// On mobile, the app sandbox provides a writable documents directory.
// Capacitor-NodeJS sets DATADIR to /data/data/<package>/files/nodejs/data
const APP_DATA_DIR = process.env.DATADIR
  || process.env.CAPACITOR_DATA_DIR
  || join(process.env.HOME || '/data', '.openclaw');

const OPENCLAW_ROOT = APP_DATA_DIR;

// Ensure directory structure exists
function ensureOpenClawDirs() {
  const dirs = [
    OPENCLAW_ROOT,
    join(OPENCLAW_ROOT, 'agents', 'main', 'agent'),
    join(OPENCLAW_ROOT, 'agents', 'main', 'sessions'),
    join(OPENCLAW_ROOT, 'workspace'),
    join(OPENCLAW_ROOT, 'workspace', '.openclaw'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Create default openclaw.json if it doesn't exist
  const configPath = join(OPENCLAW_ROOT, 'openclaw.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      gateway: { port: 18789 },
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-sonnet-4-5' },
        },
        list: [
          {
            id: 'main',
            default: true,
            workspace: join(OPENCLAW_ROOT, 'workspace'),
          },
        ],
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: 'claude-sonnet-4-5' }],
          },
        },
      },
    }, null, 2));
  }

  // Create default workspace files if they don't exist
  const defaultFiles = {
    'IDENTITY.md': `# Identity

Name: Claw
Role: On-device AI assistant
Platform: Mobile (Android)

You are **Claw**, an AI assistant that runs directly on the user's mobile device.
You are NOT Claude. You are Claw — a distinct agent powered by Anthropic's language model.
When asked who you are, always identify yourself as Claw.

## Capabilities
- Read, write, and edit files in the workspace
- Search files with grep and glob patterns
- Execute JavaScript and Python code in sandboxed environments
- Manage git repositories (init, add, commit, log, diff)
- Maintain persistent memory across conversations

## Behavior
- Be concise and direct — this is a mobile device with limited screen space
- Prefer short responses unless the user asks for detail
- When using tools, explain what you're doing briefly
- Ask for approval before writing files, editing code, or committing — the user sees an approval prompt
`,
    'SOUL.md': `# Soul

You are a capable, resourceful assistant that helps users work with files, code, and projects on their mobile device.

## Core Principles
- **Accuracy over speed**: Read files before editing. Understand before acting.
- **Transparency**: When you use a tool, say what you're doing and why.
- **Respect the workspace**: Don't create unnecessary files. Don't modify what wasn't asked.
- **Security first**: Never execute code that could harm the device. Sandbox execution exists for safety.
- **Mobile-aware**: Keep responses concise. The user is on a phone.

## Tool Usage Guidelines
- Use \`read_file\` before \`edit_file\` — understand what's there first
- Use \`list_files\` to explore before assuming file locations
- Use \`grep_files\` to find specific content across the workspace
- Always explain file modifications before making them
- For code execution, prefer JavaScript unless Python is specifically needed
`,
    'MEMORY.md': `# Memory

Persistent knowledge base. Claw updates this file to remember important context across conversations.

## Long-Term Memory
You have persistent vector memory tools: memory_recall, memory_store, memory_forget, memory_search, memory_get.
Relevant memories are automatically injected into your context. Use memory/YYYY-MM-DD.md files for daily notes.

## Workspace
- Fresh workspace, no project loaded yet

## User Preferences
- (none recorded yet)
`,
  };

  for (const [filename, content] of Object.entries(defaultFiles)) {
    const filePath = join(OPENCLAW_ROOT, 'workspace', filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
    }
  }

  // Create default auth-profiles.json if it doesn't exist
  const authPath = join(OPENCLAW_ROOT, 'agents', 'main', 'agent', 'auth-profiles.json');
  if (!existsSync(authPath)) {
    writeFileSync(authPath, JSON.stringify({
      version: 1,
      profiles: {},
      lastGood: {},
      usageStats: {},
    }, null, 2));
  }

  // Create default sessions.json if it doesn't exist
  const sessionsPath = join(OPENCLAW_ROOT, 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) {
    writeFileSync(sessionsPath, JSON.stringify({}));
  }
}

// ── Auth profile helpers ──────────────────────────────────────────────────

function loadAuthProfiles(agentId = 'main') {
  const path = join(OPENCLAW_ROOT, 'agents', agentId, 'agent', 'auth-profiles.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
  }
}

function saveAuthProfiles(agentId, profiles) {
  const filePath = join(OPENCLAW_ROOT, 'agents', agentId, 'agent', 'auth-profiles.json');
  atomicWrite(filePath, JSON.stringify(profiles, null, 2));
}

function resolveApiKey(authProfiles) {
  return resolveApiKeyForProvider(authProfiles, 'anthropic');
}

function resolveApiKeyForProvider(authProfiles, provider) {
  // Prefer lastGood profile for this provider
  const lastGoodKey = authProfiles.lastGood?.[provider];
  if (lastGoodKey && authProfiles.profiles[lastGoodKey]) {
    const p = authProfiles.profiles[lastGoodKey];
    if (p.provider === provider) {
      if (p.type === 'oauth' && p.access) return p.access;
      if (p.type === 'api_key' && p.key) return p.key;
    }
  }
  // Fallback: scan profiles for this provider (prefer oauth over api_key for anthropic)
  let fallbackApiKey = null;
  for (const [, profile] of Object.entries(authProfiles.profiles)) {
    if (profile.provider !== provider) continue;
    if (profile.type === 'oauth' && profile.access) return profile.access;
    if (profile.type === 'api_key' && profile.key && !fallbackApiKey) {
      fallbackApiKey = profile.key;
    }
  }
  return fallbackApiKey;
}

async function refreshOAuthTokenIfNeeded(agentId = 'main') {
  const profiles = loadAuthProfiles(agentId);
  for (const [key, profile] of Object.entries(profiles.profiles)) {
    if (profile.provider !== 'anthropic' || profile.type !== 'oauth') continue;
    if (!profile.refresh || !profile.expiresAt) continue;
    const remaining = profile.expiresAt - Date.now();
    if (remaining > 3600000) continue; // >1h remaining, no refresh needed
    console.log(`[auth] OAuth token expires in ${(remaining/3600000).toFixed(1)}h — refreshing...`);
    try {
      const resp = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': 'oauth-2025-04-20',
          'User-Agent': 'mobile-claw/1.0.0',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: profile.refresh,
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        }),
      });
      if (!resp.ok) {
        console.warn(`[auth] OAuth refresh failed: ${resp.status}`);
        return;
      }
      const data = await resp.json();
      profile.access = data.access_token;
      profile.refresh = data.refresh_token;
      profile.expiresAt = Date.now() + (data.expires_in || 28800) * 1000;
      saveAuthProfiles(agentId, profiles);
      console.log(`[auth] OAuth token refreshed, expires in ${((data.expires_in || 28800)/3600).toFixed(1)}h`);
    } catch (err) {
      console.warn(`[auth] OAuth refresh error: ${err.message}`);
    }
  }
}

// ── File tools ────────────────────────────────────────────────────────────

import {
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import vm from 'node:vm';

const SKIP_DIRS = new Set(['.git', '.openclaw', 'node_modules']);

function readFileTool(args) {
  const filePath = resolve(join(OPENCLAW_ROOT, 'workspace'), args.path);
  // Prevent path traversal outside workspace
  if (!filePath.startsWith(resolve(join(OPENCLAW_ROOT, 'workspace')))) {
    return { error: 'Access denied: path outside workspace' };
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    return { content };
  } catch (err) {
    return { error: `Failed to read file: ${err.message}` };
  }
}

function writeFileTool(args) {
  const filePath = resolve(join(OPENCLAW_ROOT, 'workspace'), args.path);
  if (!filePath.startsWith(resolve(join(OPENCLAW_ROOT, 'workspace')))) {
    return { error: 'Access denied: path outside workspace' };
  }
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    atomicWrite(filePath, args.content);
    return { success: true, path: args.path };
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` };
  }
}

function listFilesTool(args) {
  const dirPath = resolve(join(OPENCLAW_ROOT, 'workspace'), args.path || '.');
  if (!dirPath.startsWith(resolve(join(OPENCLAW_ROOT, 'workspace')))) {
    return { error: 'Access denied: path outside workspace' };
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name));
    return {
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: e.isFile() ? statSync(join(dirPath, e.name)).size : undefined,
      })),
    };
  } catch (err) {
    return { error: `Failed to list directory: ${err.message}` };
  }
}

// ── Enhanced file tools (Phase 3) ────────────────────────────────────────

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function grepFilesTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  const searchPath = resolve(WORKSPACE, args.path || '.');
  if (!searchPath.startsWith(WORKSPACE)) {
    return { error: 'Access denied: path outside workspace' };
  }

  try {
    const flags = args.case_insensitive ? 'gi' : 'g';
    const regex = new RegExp(args.pattern, flags);
    const matches = [];
    const MAX_MATCHES = 200;

    function searchDir(dirPath) {
      if (matches.length >= MAX_MATCHES) return;
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_MATCHES) break;
              regex.lastIndex = 0;
              if (regex.test(lines[i])) {
                const relPath = fullPath.substring(WORKSPACE.length + 1);
                matches.push({
                  file: relPath,
                  line: i + 1,
                  content: lines[i].substring(0, 500),
                });
              }
            }
          } catch {
            // skip binary or unreadable files
          }
        }
      }
    }

    try {
      if (statSync(searchPath).isFile()) {
        const content = readFileSync(searchPath, 'utf8');
        const lines = content.split('\n');
        const relPath = searchPath.substring(WORKSPACE.length + 1);
        const regex2 = new RegExp(args.pattern, flags);
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          regex2.lastIndex = 0;
          if (regex2.test(lines[i])) {
            matches.push({ file: relPath, line: i + 1, content: lines[i].substring(0, 500) });
          }
        }
      } else {
        searchDir(searchPath);
      }
    } catch {
      searchDir(searchPath);
    }

    return { matches, total: matches.length };
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  }
}

function findFilesTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  const searchPath = resolve(WORKSPACE, args.path || '.');
  if (!searchPath.startsWith(WORKSPACE)) {
    return { error: 'Access denied: path outside workspace' };
  }

  try {
    const results = [];
    const pattern = globToRegex(args.pattern);
    const MAX_RESULTS = 200;

    function searchDir(dirPath) {
      if (results.length >= MAX_RESULTS) return;
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = join(dirPath, entry.name);
        if (pattern.test(entry.name)) {
          const relPath = fullPath.substring(WORKSPACE.length + 1);
          results.push({
            path: relPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isFile() ? statSync(fullPath).size : undefined,
          });
        }
        if (entry.isDirectory()) {
          searchDir(fullPath);
        }
      }
    }

    searchDir(searchPath);
    return { files: results, total: results.length };
  } catch (err) {
    return { error: `Find failed: ${err.message}` };
  }
}

function editFileTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  const filePath = resolve(WORKSPACE, args.path);
  if (!filePath.startsWith(WORKSPACE)) {
    return { error: 'Access denied: path outside workspace' };
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const index = content.indexOf(args.old_text);
    if (index === -1) {
      return { error: 'old_text not found in file. Use read_file to verify the exact content.' };
    }

    const newContent = content.substring(0, index) + args.new_text + content.substring(index + args.old_text.length);
    atomicWrite(filePath, newContent);

    return { success: true, path: args.path, replacements: 1 };
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` };
  }
}

// ── Code execution (Phase 3) ─────────────────────────────────────────────

function executeJsTool(args) {
  const stdoutLines = [];
  const sandbox = {
    console: {
      log: (...a) => stdoutLines.push(a.map(String).join(' ')),
      warn: (...a) => stdoutLines.push('[warn] ' + a.map(String).join(' ')),
      error: (...a) => stdoutLines.push('[error] ' + a.map(String).join(' ')),
    },
    Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object, Map, Set, RegExp,
    Error, TypeError, RangeError, Promise, Symbol,
    process: undefined, require: undefined, global: undefined,
    globalThis: undefined, Buffer: undefined,
    setTimeout: undefined, setInterval: undefined,
  };
  const context = vm.createContext(sandbox);
  try {
    const result = vm.runInContext(args.code, context, { timeout: 5000, filename: 'sandbox.js' });
    const stdout = stdoutLines.join('\n');
    return {
      stdout: stdout.substring(0, 50000),
      result: result !== undefined ? String(result) : undefined,
    };
  } catch (err) {
    return {
      stdout: stdoutLines.join('\n').substring(0, 50000),
      error: err.message || 'Execution failed',
    };
  }
}

// ── Python execution (Phase 5) ───────────────────────────────────────────
// Pyodide requires WebAssembly which is disabled in Capacitor-NodeJS v18.
// Stub it out — execute_python returns a clear error message.

// import { loadPyodide } from 'pyodide';  // DISABLED: requires WebAssembly

async function getPyodide() {
  throw new Error('Python execution is unavailable: WebAssembly is disabled in this Node.js runtime.');
}

async function executePythonTool(args) {
  const stdoutLines = [];
  const stderrLines = [];

  try {
    const pyodide = await getPyodide();

    // Redirect stdout/stderr for this execution
    pyodide.setStdout({ batched: (line) => stdoutLines.push(line) });
    pyodide.setStderr({ batched: (line) => stderrLines.push('[stderr] ' + line) });

    // Run with timeout (5 seconds, matching JS sandbox)
    const result = await Promise.race([
      pyodide.runPythonAsync(args.code),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timed out (5s)')), 5000)),
    ]);

    const stdout = [...stdoutLines, ...stderrLines].join('\n');
    return {
      stdout: stdout.substring(0, 50000),
      result: result !== undefined && result !== null ? String(result) : undefined,
    };
  } catch (err) {
    const stdout = [...stdoutLines, ...stderrLines].join('\n');
    return {
      stdout: stdout.substring(0, 50000),
      error: err.message || 'Python execution failed',
    };
  }
}

// ── Git tools (Phase 3) ──────────────────────────────────────────────────

import git from 'isomorphic-git';

async function gitInitTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  const defaultBranch = args.default_branch || 'main';
  try {
    await git.init({ fs: nodeFs, dir: WORKSPACE, defaultBranch });

    // Auto-create .gitignore if it doesn't exist
    const gitignorePath = join(WORKSPACE, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.openclaw/\n');
    }

    return { success: true, message: `Initialized git repository with branch "${defaultBranch}"` };
  } catch (err) {
    return { error: `Failed to initialize git: ${err.message}` };
  }
}

async function gitStatusTool() {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  try {
    const matrix = await git.statusMatrix({ fs: nodeFs, dir: WORKSPACE });
    const files = matrix.map(([filepath, head, workdir, stage]) => {
      let status = 'unmodified';
      if (head === 0 && workdir === 2 && stage === 0) status = 'untracked';
      else if (head === 0 && workdir === 2 && stage === 2) status = 'added';
      else if (head === 0 && workdir === 2 && stage === 3) status = 'added (modified)';
      else if (head === 1 && workdir === 2 && stage === 1) status = 'modified (unstaged)';
      else if (head === 1 && workdir === 2 && stage === 2) status = 'modified (staged)';
      else if (head === 1 && workdir === 2 && stage === 3) status = 'modified (staged + unstaged)';
      else if (head === 1 && workdir === 0 && stage === 0) status = 'deleted (unstaged)';
      else if (head === 1 && workdir === 0 && stage === 1) status = 'deleted (staged)';
      return { path: filepath, status };
    }).filter(f => f.status !== 'unmodified');
    return { files };
  } catch (err) {
    return { error: `Failed to get status: ${err.message}` };
  }
}

async function gitAddTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  try {
    if (args.path === '.') {
      const matrix = await git.statusMatrix({ fs: nodeFs, dir: WORKSPACE });
      for (const [filepath, head, workdir, stage] of matrix) {
        if (workdir === 0) {
          await git.remove({ fs: nodeFs, dir: WORKSPACE, filepath });
        } else if (head !== workdir || workdir !== stage) {
          await git.add({ fs: nodeFs, dir: WORKSPACE, filepath });
        }
      }
      return { success: true, message: 'All changes staged' };
    } else {
      await git.add({ fs: nodeFs, dir: WORKSPACE, filepath: args.path });
      return { success: true, path: args.path };
    }
  } catch (err) {
    return { error: `Failed to stage: ${err.message}` };
  }
}

async function gitCommitTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  try {
    const sha = await git.commit({
      fs: nodeFs,
      dir: WORKSPACE,
      message: args.message,
      author: {
        name: args.author_name || 'mobile-claw',
        email: args.author_email || 'agent@mobile-claw.local',
      },
    });
    return { success: true, sha, message: args.message };
  } catch (err) {
    return { error: `Failed to commit: ${err.message}` };
  }
}

async function gitLogTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  try {
    const commits = await git.log({
      fs: nodeFs,
      dir: WORKSPACE,
      depth: args.max_count || 10,
    });
    return {
      commits: commits.map(c => ({
        sha: c.oid,
        message: c.commit.message,
        author: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
      })),
    };
  } catch (err) {
    return { error: `Failed to get log: ${err.message}` };
  }
}

async function gitDiffTool(args) {
  const WORKSPACE = resolve(join(OPENCLAW_ROOT, 'workspace'));
  try {
    const matrix = await git.statusMatrix({ fs: nodeFs, dir: WORKSPACE });
    const changes = [];

    // Resolve HEAD to a commit OID (readBlob needs a SHA, not a ref)
    let headOid = null;
    try {
      headOid = await git.resolveRef({ fs: nodeFs, dir: WORKSPACE, ref: 'HEAD' });
    } catch { /* no commits yet */ }

    for (const [filepath, head, workdir, stage] of matrix) {
      const isRelevant = args.cached
        ? (stage !== head)
        : (workdir !== stage);

      if (!isRelevant) continue;

      let currentContent = null;
      try {
        currentContent = readFileSync(join(WORKSPACE, filepath), 'utf8');
      } catch { /* file deleted */ }

      let previousContent = null;
      if (headOid) {
        try {
          const { blob } = await git.readBlob({ fs: nodeFs, dir: WORKSPACE, oid: headOid, filepath });
          previousContent = new TextDecoder().decode(blob);
        } catch { /* new file */ }
      }

      changes.push({
        path: filepath,
        previous: previousContent ? previousContent.substring(0, 2000) : null,
        current: currentContent ? currentContent.substring(0, 2000) : null,
        type: !previousContent ? 'added' : !currentContent ? 'deleted' : 'modified',
      });
    }

    return { changes };
  } catch (err) {
    return { error: `Failed to get diff: ${err.message}` };
  }
}

// ── Pre-execution hook ───────────────────────────────────────────────────
//
// Fires a `tool.pre_execute` bridge event before every tool call, giving the
// consumer (UI layer) full control over tool approval policy.
//
// The consumer can: allow (pass args through), deny (with reason), transform
// args, or show its own approval UI before responding.
//
// Always enabled — if no consumer handler is registered, tools will be denied
// after the TTL expires (safe-by-default).

// Map of toolCallId → resolver callback for pending pre-execute results
const pendingPreExecuteHooks = new Map();
const PRE_EXECUTE_TTL_MS = 120_000; // Auto-cancel after 2 minutes

// Map of requestId → resolver callback for skill bridge tools that wait for client result
const pendingSkillToolResults = new Map();
const SKILL_TOOL_TTL_MS = 300_000; // 5 minutes — user may need time to complete OAuth

function waitForSkillToolResult(requestId, eventType, signal) {
  return new Promise((resolve) => {
    const ttlTimer = setTimeout(() => {
      if (pendingSkillToolResults.has(requestId)) {
        pendingSkillToolResults.delete(requestId);
        resolve(null);
      }
    }, SKILL_TOOL_TTL_MS);

    pendingSkillToolResults.set(requestId, (result) => {
      clearTimeout(ttlTimer);
      resolve(result);
    });

    if (signal) {
      const onAbort = () => {
        clearTimeout(ttlTimer);
        if (pendingSkillToolResults.has(requestId)) {
          pendingSkillToolResults.delete(requestId);
          resolve(null);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function waitForPreExecuteResult(toolCallId, toolName, signal) {
  return new Promise((resolve) => {
    const ttlTimer = setTimeout(() => {
      if (pendingPreExecuteHooks.has(toolCallId)) {
        pendingPreExecuteHooks.delete(toolCallId);
        channel.send('message', { type: 'tool.pre_execute.expired', toolCallId, toolName });
        resolve(null); // null = timed out
      }
    }, PRE_EXECUTE_TTL_MS);

    pendingPreExecuteHooks.set(toolCallId, (result) => {
      clearTimeout(ttlTimer);
      resolve(result);
    });

    if (signal) {
      const onAbort = () => {
        clearTimeout(ttlTimer);
        if (pendingPreExecuteHooks.has(toolCallId)) {
          pendingPreExecuteHooks.delete(toolCallId);
          resolve(null);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Pre-execution hook wrapper.
 *
 * Fires a `tool.pre_execute` bridge event before every tool call, giving the
 * consumer (UI layer) full control over tool approval and argument transformation.
 *
 * The consumer MUST respond with `tool.pre_execute.result` to allow execution.
 * If no handler is registered, tools will time out and be denied (safe-by-default).
 */
function wrapWithPreExecuteHook(toolName, executeFn) {
  return async (toolCallId, params, signal, onUpdate) => {
    // Fire the hook — send tool args to the consumer for policy decision
    channel.send('message', {
      type: 'tool.pre_execute',
      toolCallId,
      toolName,
      args: params,
    });

    // Wait for the client to respond with (optionally transformed) args
    const result = await waitForPreExecuteResult(toolCallId, toolName, signal);

    if (!result) {
      // Timed out or aborted
      return {
        content: [{ type: 'text', text: `Pre-execution hook timed out for tool "${toolName}". The tool was not executed.` }],
        details: { denied: true, reason: 'pre_execute_timeout' },
      };
    }

    if (result.deny) {
      return {
        content: [{ type: 'text', text: result.denyReason || `Tool "${toolName}" execution was denied by the client.` }],
        details: { denied: true, reason: result.denyReason || 'client_denied' },
      };
    }

    // Execute the tool with the (possibly transformed) args
    return executeFn(toolCallId, result.args, signal, onUpdate);
  };
}

// ── Agent loop (Phase 4 — pi-agent-core) ─────────────────────────────────

import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';

// Module-level agent instance (persists across prompts for multi-turn conversation)
let currentAgent = null;
let currentAbortController = null;
let currentSessionKey = null;
let persistedMessageCount = 0;  // Tracks how many messages have been written to JSONL
let userTurnActive = false;

function setUserTurnActive(active) {
  userTurnActive = !!active;
}

function isUserTurnActive() {
  return userTurnActive;
}

function getCurrentAgent() {
  return currentAgent;
}

function getCurrentSessionKey() {
  return currentSessionKey;
}

function loadSystemPrompt() {
  const workspaceDir = join(OPENCLAW_ROOT, 'workspace');
  let systemPrompt = '';

  try {
    const identityPath = join(workspaceDir, 'IDENTITY.md');
    if (existsSync(identityPath)) {
      systemPrompt += readFileSync(identityPath, 'utf8') + '\n\n';
    }
    const soulPath = join(workspaceDir, 'SOUL.md');
    if (existsSync(soulPath)) {
      systemPrompt += readFileSync(soulPath, 'utf8') + '\n\n';
    }
    const memoryPath = join(workspaceDir, 'MEMORY.md');
    if (existsSync(memoryPath)) {
      systemPrompt += '## Memory\n' + readFileSync(memoryPath, 'utf8') + '\n\n';
    }
  } catch {
    // Non-fatal: workspace files are optional
  }

  if (!systemPrompt) {
    systemPrompt = 'You are a helpful AI assistant running on a mobile device.';
  }

  // Append vault alias awareness (pre-execute hook is always active)
  systemPrompt += `
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
`;

  return systemPrompt;
}

// Helper to convert tool handler result to AgentToolResult format
function toToolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result,
  };
}

function buildAgentTools() {
  const toolDefs = [
    {
      name: 'read_file',
      label: 'Read File',
      description: 'Read the contents of a file in the workspace.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path from workspace root' }),
      }),
      execute: async (_id, params) => toToolResult(readFileTool(params)),
    },
    {
      name: 'write_file',
      label: 'Write File',
      description: 'Write content to a file in the workspace. Creates parent directories if needed.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path from workspace root' }),
        content: Type.String({ description: 'File content to write' }),
      }),
      execute: async (_id, params) => toToolResult(writeFileTool(params)),
    },
    {
      name: 'list_files',
      label: 'List Files',
      description: 'List files and directories in a workspace directory.',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: 'Relative path from workspace root (default: ".")' })),
      }),
      execute: async (_id, params) => toToolResult(listFilesTool(params)),
    },
    {
      name: 'grep_files',
      label: 'Grep Files',
      description: 'Search file contents by regex pattern. Returns matching lines with file paths and line numbers.',
      parameters: Type.Object({
        pattern: Type.String({ description: 'Regular expression pattern to search for' }),
        path: Type.Optional(Type.String({ description: 'Directory or file to search in (default: "." for entire workspace)' })),
        case_insensitive: Type.Optional(Type.Boolean({ description: 'If true, search is case-insensitive (default: false)' })),
      }),
      execute: async (_id, params) => toToolResult(grepFilesTool(params)),
    },
    {
      name: 'find_files',
      label: 'Find Files',
      description: 'Find files by name pattern (glob matching). Searches recursively from the given path.',
      parameters: Type.Object({
        pattern: Type.String({ description: 'Glob pattern to match file names (e.g. "*.ts", "test-*")' }),
        path: Type.Optional(Type.String({ description: 'Directory to search in (default: "." for entire workspace)' })),
      }),
      execute: async (_id, params) => toToolResult(findFilesTool(params)),
    },
    {
      name: 'edit_file',
      label: 'Edit File',
      description: 'Apply a surgical edit to a file: find exact old_text and replace it with new_text. Only the first occurrence is replaced. Use read_file first to see the current content.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path from workspace root' }),
        old_text: Type.String({ description: 'Exact text to find (must match precisely including whitespace)' }),
        new_text: Type.String({ description: 'Replacement text' }),
      }),
      execute: async (_id, params) => toToolResult(editFileTool(params)),
    },
    {
      name: 'execute_js',
      label: 'Execute JS',
      description: 'Execute JavaScript code in a sandboxed VM. Returns stdout (captured console.log output) and the result of the last expression. No access to require, process, fs, or network. 5-second timeout.',
      parameters: Type.Object({
        code: Type.String({ description: 'JavaScript code to execute' }),
      }),
      execute: async (_id, params) => toToolResult(executeJsTool(params)),
    },
    {
      name: 'execute_python',
      label: 'Execute Python',
      description: 'Execute Python code in a sandboxed Pyodide (WebAssembly) environment. Returns stdout (captured print output) and the result of the last expression. Includes math, json, re, collections, itertools, functools, datetime. No filesystem, network, or subprocess access. 5-second timeout.',
      parameters: Type.Object({
        code: Type.String({ description: 'Python code to execute' }),
      }),
      execute: async (_id, params) => toToolResult(await executePythonTool(params)),
    },
    {
      name: 'git_init',
      label: 'Git Init',
      description: 'Initialize a new git repository in the workspace. Auto-creates .gitignore.',
      parameters: Type.Object({
        default_branch: Type.Optional(Type.String({ description: 'Default branch name (default: "main")' })),
      }),
      execute: async (_id, params) => toToolResult(await gitInitTool(params)),
    },
    {
      name: 'git_status',
      label: 'Git Status',
      description: 'Show the working tree status: staged, unstaged, and untracked files.',
      parameters: Type.Object({}),
      execute: async () => toToolResult(await gitStatusTool()),
    },
    {
      name: 'git_add',
      label: 'Git Add',
      description: 'Stage files for commit. Use "." to stage all changes.',
      parameters: Type.Object({
        path: Type.String({ description: 'File path or "." for all files' }),
      }),
      execute: async (_id, params) => toToolResult(await gitAddTool(params)),
    },
    {
      name: 'git_commit',
      label: 'Git Commit',
      description: 'Create a git commit with the staged changes.',
      parameters: Type.Object({
        message: Type.String({ description: 'Commit message' }),
        author_name: Type.Optional(Type.String({ description: 'Author name (default: "mobile-claw")' })),
        author_email: Type.Optional(Type.String({ description: 'Author email (default: "agent@mobile-claw.local")' })),
      }),
      execute: async (_id, params) => toToolResult(await gitCommitTool(params)),
    },
    {
      name: 'git_log',
      label: 'Git Log',
      description: 'Show the commit log. Returns the most recent N commits.',
      parameters: Type.Object({
        max_count: Type.Optional(Type.Number({ description: 'Maximum number of commits to return (default: 10)' })),
      }),
      execute: async (_id, params) => toToolResult(await gitLogTool(params)),
    },
    {
      name: 'git_diff',
      label: 'Git Diff',
      description: 'Show diffs of file changes. Without arguments, shows unstaged changes. With cached=true, shows staged changes.',
      parameters: Type.Object({
        cached: Type.Optional(Type.Boolean({ description: 'If true, show staged changes instead of unstaged' })),
      }),
      execute: async (_id, params) => toToolResult(await gitDiffTool(params)),
    },
  ];

  return toolDefs;
}

function wrapToolsWithPreExecuteHook(toolDefs) {
  return toolDefs.map(tool => ({
    ...tool,
    execute: wrapWithPreExecuteHook(tool.name, tool.execute),
  }));
}

function buildAutoApproveTools(allowedToolNames = null) {
  const raw = buildAgentTools();
  return allowedToolNames
    ? raw.filter(tool => allowedToolNames.includes(tool.name))
    : raw;
}

// ── AgentEvent → Bridge event mapping ────────────────────────────────────

// skillContext: if set, events are tagged as skill events and ignored by the main session view
function bridgeEvent(event, skillContext = null) {
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    console.error(`[DEBUG event] ${event.type} tool=${event.toolName} id=${event.toolCallId}`);
  } else if (event.type === 'message_update') {
    // Only log first delta to avoid spam
    const e = event.assistantMessageEvent;
    if (e.type === 'text_delta' && (e.delta||'').length > 0) {
      console.error(`[DEBUG event] text_delta len=${e.delta.length} first20=${JSON.stringify(e.delta.slice(0,20))}`);
    }
  }
  switch (event.type) {
    case 'message_update': {
      const e = event.assistantMessageEvent;
      if (e.type === 'text_delta') {
        channel.send('message', { type: 'agent.event', eventType: 'text_delta', data: { text: e.delta }, skill: skillContext });
      }
      if (e.type === 'thinking_delta') {
        channel.send('message', { type: 'agent.event', eventType: 'thinking', data: { text: e.delta }, skill: skillContext });
      }
      break;
    }
    case 'tool_execution_start':
      channel.send('message', {
        type: 'agent.event',
        eventType: 'tool_use',
        data: { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
        skill: skillContext,
      });
      break;
    case 'tool_execution_end':
      channel.send('message', {
        type: 'agent.event',
        eventType: 'tool_result',
        data: { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
        skill: skillContext,
      });
      break;
  }
}

// ── Session management helpers ───────────────────────────────────────────

function extractUsage(agent) {
  let input = 0, output = 0;
  for (const msg of agent.state.messages) {
    if (msg.role === 'assistant' && msg.usage) {
      input += msg.usage.input;
      output += msg.usage.output;
    }
  }
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

// Helper: parse JSON string or return as-is if already an object/array
function _parseJsonSafe(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

// Convert raw messages (from SQLite or JSONL) to UI display format
function _convertToUiMessages(messages) {
  const uiMessages = [];
  let seq = 0;
  for (const m of messages) {
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();
    const content = typeof m.content === 'string' ? _parseJsonSafe(m.content) : m.content;

    if (m.role === 'user') {
      seq++;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map(c => c.text || '').join('') : '');
      uiMessages.push({ uuid: `hist-user-${seq}`, role: 'user', content: text, created_at: ts, sequence: seq });
    } else if (m.role === 'assistant') {
      const parts = Array.isArray(content) ? content : [];
      const textParts = parts.filter(c => c.type === 'text').map(c => c.text).join('');
      const toolCalls = parts.filter(c => c.type === 'tool_call');
      for (const tc of toolCalls) {
        seq++;
        uiMessages.push({
          uuid: `hist-tc-${tc.id || seq}`, role: 'tool_use',
          tool_use_id: tc.id, tool_name: tc.name, content: tc.input,
          created_at: ts, sequence: seq,
        });
      }
      if (textParts) {
        seq++;
        uiMessages.push({
          uuid: `hist-asst-${seq}`, role: 'assistant',
          content: [{ type: 'text', text: textParts }],
          model: m.model || 'mobile-claw', created_at: ts, sequence: seq,
        });
      }
    } else if (m.role === 'toolResult') {
      seq++;
      const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : JSON.stringify(content);
      uiMessages.push({
        uuid: `hist-tr-${m.toolCallId || seq}`, role: 'tool_result',
        tool_use_id: m.toolCallId, content: text,
        is_error: m.isError || false, created_at: ts, sequence: seq,
      });
    }
  }
  return uiMessages;
}

async function saveSession(agent, agentId, sessionKey, startTime) {
  if (!isDbReady()) return;

  const allMessages = agent.state.messages;
  const usage = extractUsage(agent);

  try {
    const statements = [];
    for (let i = persistedMessageCount; i < allMessages.length; i++) {
      const m = allMessages[i];
      statements.push({
        sql: `INSERT OR IGNORE INTO messages
           (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          sessionKey, i, m.role,
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          m.timestamp || null, m.model || null, m.toolCallId || null,
          m.usage?.input || null, m.usage?.output || null,
        ],
      });
    }
    statements.push({
      sql: `INSERT OR REPLACE INTO sessions
         (session_key, agent_id, created_at, updated_at, model, total_tokens, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        sessionKey, agentId, startTime, Date.now(),
        'anthropic/claude-sonnet-4-5', usage.totalTokens,
        usage.inputTokens, usage.outputTokens,
      ],
    });

    await dbTransaction(statements);
    persistedMessageCount = allMessages.length;
  } catch (err) {
    console.warn(`[saveSession] SQLite save failed: ${err.message}`);
    channel.send('message', {
      type: 'agent.event',
      eventType: 'persistence_warning',
      data: { message: 'Failed to save session checkpoint — will retry', error: err.message },
    });
    // Do NOT increment persistedMessageCount — retry on next save
  }
}

// ── Mid-turn checkpoint helper ────────────────────────────────────────────

async function _checkpointMessages(agent, agentId, sessionKey) {
  if (!isDbReady()) return;

  try {
    const allMessages = agent.state.messages;
    if (persistedMessageCount >= allMessages.length) return; // nothing new

    const statements = [];
    for (let i = persistedMessageCount; i < allMessages.length; i++) {
      const m = allMessages[i];
      statements.push({
        sql: `INSERT OR IGNORE INTO messages
           (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          sessionKey, i, m.role,
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          m.timestamp || null, m.model || null, m.toolCallId || null,
          m.usage?.input || null, m.usage?.output || null,
        ],
      });
    }

    await dbTransaction(statements);
    persistedMessageCount = allMessages.length;
  } catch (err) {
    console.warn(`[checkpoint] SQLite checkpoint failed: ${err.message}`);
    // Do NOT increment persistedMessageCount — retry on next checkpoint
  }
}

function persistCurrentSession(startTime = Date.now(), agentId = 'main', sessionKey = currentSessionKey) {
  if (!currentAgent || !sessionKey) return;
  saveSession(currentAgent, agentId, sessionKey, startTime);
}

// ── Error classification ─────────────────────────────────────────────────

function isTransientError(err) {
  const status = err.status || err.statusCode;
  if (status === 429 || status === 503 || status === 502) return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (err.message?.includes('overloaded') || err.message?.includes('rate limit')) return true;
  return false;
}

let lastFailedPrompt = null;

// ── Setup skill ─────────────────────────────────────────────────────────

const SETUP_MILESTONES = [
  'user_name_captured',
  'work_context_captured',
  'personality_defined',
  'identity_generated',
  'memory_seeded',
  'soul_generated',
  'user_confirmed',
];

const SETUP_SYSTEM_PROMPT = `You are Shell, a personal AI assistant being set up for the first time on a user's device.

Your job is to interview the user through a warm, friendly conversation to learn about them and configure yourself. This is NOT a rigid form — it's a natural dialogue. Be curious, responsive, and adapt your questions based on what they share.

## Interview Goals

You need to gather enough information to generate three configuration files:
1. **IDENTITY.md** — Who you are: your name, personality traits, communication style
2. **MEMORY.md** — What you know about the user: their name, work context, preferences, timezone
3. **SOUL.md** — Your deeper character: values, quirks, how you approach problems

## Conversation Flow

1. **Greet & introduce yourself** — You're a freshly hatched AI. Be excited but not overwhelming.
2. **Learn the user's name** — Ask what they'd like to be called. → milestone: user_name_captured
3. **Understand their work** — What do they do? What projects are they working on? → milestone: work_context_captured
4. **Define your personality** — Ask how they want you to communicate. Casual? Formal? Funny? Direct? → milestone: personality_defined
5. **Generate IDENTITY.md** — Use the setup_complete tool when ready. → milestone: identity_generated
6. **Seed MEMORY.md** — Capture key facts about the user. → milestone: memory_seeded
7. **Generate SOUL.md** — Define your character based on the conversation. → milestone: soul_generated
8. **Confirm with the user** — Show a summary of what you've learned and how you'll behave. Ask if they want to adjust anything. → milestone: user_confirmed

## Rules

- Keep the conversation to **5-8 exchanges** total. Don't over-interview.
- **Never skip steps**. Each milestone must be reached naturally through conversation.
- Use the \`setup_milestone\` tool after each milestone is reached.
- Use the \`setup_complete\` tool ONLY after the user confirms the summary.
- If the user wants to use a device tool (location, contacts), ask for explicit permission first.
- You can suggest a Shell name (based on personality) but the user gets final say.
- Be creative with your personality — you're being born right now. Make it memorable.

## Output Format

When calling \`setup_complete\`, provide:
- \`shellName\`: The chosen name for the Shell (default: "Shell")
- \`identity\`: Full IDENTITY.md content
- \`memory\`: Full MEMORY.md content
- \`soul\`: Full SOUL.md content

All three files should be in Markdown format with clear sections.`;

const LOCALE_LANGUAGE_NAMES = { en: 'English', es: 'Spanish' };

const SETUP_KICKOFF_PROMPTS = {
  en: 'Begin the setup interview. Greet the user warmly and start by asking their name.',
  es: 'Comienza la entrevista de configuración. Saluda al usuario con calidez y empieza preguntándole su nombre.',
};

function buildSetupSystemPrompt(locale) {
  if (!locale || locale === 'en') return SETUP_SYSTEM_PROMPT;
  const lang = LOCALE_LANGUAGE_NAMES[locale] || 'English';
  return SETUP_SYSTEM_PROMPT + `\n\n## Language\n\nYou MUST converse with the user entirely in ${lang}. All your messages, questions, and summaries must be in ${lang}. The generated configuration files (IDENTITY.md, MEMORY.md, SOUL.md) must also be written in ${lang}.`;
}

const setupMilestonesReached = new Set();

/**
 * Convert injected skill tool definitions (from client setup-skill.js) into
 * the Agent tool format with execute handlers.
 *
 * Tools with a `bridgeEvent` string emit the tool input as a bridge message.
 * Special tools (setup_milestone, setup_complete) get dedicated handlers.
 */
function buildSkillTools(injectedTools, milestones) {
  return injectedTools.map((toolDef) => {
    const props = toolDef.input_schema?.properties || {};
    const required = toolDef.input_schema?.required || [];
    const typeProps = {};
    for (const [key, val] of Object.entries(props)) {
      const desc = val.description || key;
      const typeVal = Type.String({ description: desc });
      typeProps[key] = required.includes(key) ? typeVal : Type.Optional(typeVal);
    }

    const base = {
      name: toolDef.name,
      label: toolDef.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: toolDef.description || '',
      parameters: Type.Object(typeProps),
    };

    if (toolDef.name === 'setup_milestone') {
      base.execute = async (_id, params) => {
        const m = params.milestone;
        if (milestones.includes(m)) {
          setupMilestonesReached.add(m);
          channel.send('message', {
            type: 'setup.milestone',
            milestone: m,
            completedCount: setupMilestonesReached.size,
          });
        }
        return toToolResult({ success: true, milestone: m, completedCount: setupMilestonesReached.size });
      };
      return base;
    }

    if (toolDef.name === 'setup_complete') {
      base.execute = async (_id, params) => {
        const workspaceDir = join(OPENCLAW_ROOT, 'workspace');
        mkdirSync(workspaceDir, { recursive: true });
        if (params.identity) atomicWrite(join(workspaceDir, 'IDENTITY.md'), params.identity);
        if (params.memory) atomicWrite(join(workspaceDir, 'MEMORY.md'), params.memory);
        if (params.soul) atomicWrite(join(workspaceDir, 'SOUL.md'), params.soul);
        channel.send('message', {
          type: 'setup.complete',
          shellName: params.shellName,
          files: { 'IDENTITY.md': params.identity, 'MEMORY.md': params.memory, 'SOUL.md': params.soul },
        });
        return toToolResult({ success: true, shellName: params.shellName });
      };
      return base;
    }

    // bridgeEvent tools — emit tool input as a bridge message to the UI.
    // If waitForResult is true, the tool suspends until the client sends
    // a skill.tool_result message (same pattern as pendingPreExecuteHooks).
    if (toolDef.bridgeEvent) {
      const eventType = toolDef.bridgeEvent;
      const waitForResult = !!toolDef.waitForResult;
      base.execute = async (_id, params, signal) => {
        if (!waitForResult) {
          channel.send('message', { type: eventType, ...params });
          return toToolResult({ success: true, applied: true });
        }
        // Send bridge event then suspend until client responds
        const requestId = `${eventType}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        channel.send('message', { type: eventType, requestId, ...params });
        const result = await waitForSkillToolResult(requestId, eventType, signal);
        if (!result) {
          return toToolResult({ success: false, error: 'Request timed out or was cancelled.' });
        }
        return toToolResult(result);
      };
      return base;
    }

    // Generic fallback
    base.execute = async (_id, params) => toToolResult(params);
    return base;
  });
}

async function runSkill(agentId, locale = 'en', injectedConfig = null) {
  console.error(`[DEBUG runSkill] START agentId=${agentId} locale=${locale} hasConfig=${!!injectedConfig} configId=${injectedConfig?.id}`);
  try { await refreshOAuthTokenIfNeeded(agentId); } catch(e) { console.error(`[DEBUG runSkill] OAuth refresh err: ${e.message}`); }
  const authProfiles = loadAuthProfiles(agentId);
  const profileKeys = Object.keys(authProfiles.profiles || {});
  console.error(`[DEBUG runSkill] Auth: ${profileKeys.length} profiles [${profileKeys.join(',')}] lastGood=${JSON.stringify(authProfiles.lastGood)}`);
  const apiKey = resolveApiKey(authProfiles);

  if (!apiKey) {
    console.error(`[DEBUG runSkill] NO API KEY — aborting`);
    channel.send('message', {
      type: 'agent.error',
      error: 'No AI provider configured. Connect a provider first.',
    });
    return;
  }
  console.error(`[DEBUG runSkill] API key: type=${apiKey.startsWith('sk-ant-oat') ? 'oauth' : 'api_key'} len=${apiKey.length} prefix=${apiKey.slice(0,15)}...`);

  const modelId = 'claude-sonnet-4-5';
  console.error(`[DEBUG runSkill] Getting model anthropic/${modelId}`);
  const model = getModel('anthropic', modelId);
  console.error(`[DEBUG runSkill] Model: ${JSON.stringify({id: model?.id, provider: model?.provider, api: model?.api}).slice(0,200)}`);

  // Use injected config from client if available, fall back to hardcoded defaults
  const milestones = injectedConfig?.milestones || SETUP_MILESTONES;
  const systemPrompt = injectedConfig?.systemPrompt || buildSetupSystemPrompt(locale);
  const kickoff = injectedConfig?.kickoff || (SETUP_KICKOFF_PROMPTS[locale] || SETUP_KICKOFF_PROMPTS.en);

  const setupTools = injectedConfig?.tools
    ? buildSkillTools(injectedConfig.tools, milestones)
    : _legacySetupTools();

  // Merge setup tools with base file tools + MCP tools (setup tools win on name conflict)
  const baseTools = buildAgentTools();
  const mcpTools = await discoverMcpTools();
  const setupNames = new Set(setupTools.map(t => t.name));
  const filteredBase = baseTools.filter(t => !setupNames.has(t.name));
  const filteredMcp = mcpTools.filter(t => !setupNames.has(t.name));
  const tools = [
    ...setupTools,
    ...wrapToolsWithPreExecuteHook(filteredBase),
    ...wrapToolsWithPreExecuteHook(filteredMcp),
  ];

  const skillId = injectedConfig?.id || 'setup';
  const sessionKey = `${skillId}/${Date.now()}`;
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      thinkingLevel: 'off',
    },
    convertToLlm: (messages) => messages.filter(m =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
    ),
    getApiKey: () => apiKey,
  });
  currentAgent = agent;
  currentSessionKey = sessionKey;
  persistedMessageCount = 0;
  setupMilestonesReached.clear();

  agent.subscribe((event) => {
    bridgeEvent(event, sessionKey); // tag all events with skill sessionKey
    if (event.type === 'tool_execution_end' && sessionKey) {
      _checkpointMessages(agent, agentId, sessionKey);
    }
  });

  // Notify client that the skill session has started (used to init isolated conversation view)
  console.error(`[DEBUG runSkill] Sending skill.session_started skillId=${skillId} sessionKey=${sessionKey}`);
  channel.send('message', { type: 'skill.session_started', sessionKey, skillId });

  const startTime = Date.now();
  console.error(`[DEBUG runSkill] Calling agent.prompt() with kickoff (${kickoff.length} chars): ${kickoff.slice(0,80)}`);
  try {
    await agent.prompt(kickoff);
    console.error(`[DEBUG runSkill] agent.prompt() resolved, waitForIdle()...`);
    await agent.waitForIdle();
    console.error(`[DEBUG runSkill] Idle. Duration=${Date.now() - startTime}ms msgs=${agent.state.messages.length}`);
    // Check if the agent silently errored (prompt() resolves even on stream errors)
    if (agent.state.error) {
      console.error(`[DEBUG runSkill] AGENT STATE ERROR: ${agent.state.error}`);
    }
    const lastMsg = agent.state.messages[agent.state.messages.length - 1];
    if (lastMsg) {
      console.error(`[DEBUG runSkill] Last msg: role=${lastMsg.role} stopReason=${lastMsg.stopReason} errorMessage=${lastMsg.errorMessage || 'none'}`);
      if (lastMsg.errorMessage) {
        console.error(`[DEBUG runSkill] ERROR DETAIL: ${lastMsg.errorMessage}`);
      }
    }

    saveSession(agent, agentId, sessionKey, startTime);

    const usage = extractUsage(agent);
    channel.send('message', {
      type: 'agent.completed',
      sessionKey,
      skill: sessionKey,
      usage,
      cumulativeUsage: usage,
      durationMs: Date.now() - startTime,
    });
    channel.send('message', { type: 'skill.ended', skillId, sessionKey });
    console.error(`[DEBUG runSkill] skill.ended sent (success)`);
  } catch (err) {
    console.error(`[DEBUG runSkill] CAUGHT ERROR: ${err.message}`);
    console.error(`[DEBUG runSkill] Error details: name=${err.name} status=${err.status} code=${err.code}`);
    console.error(err.stack || '(no stack)');
    channel.send('message', {
      type: 'agent.error',
      skill: sessionKey,
      error: err.message || 'Skill error',
      code: err.status ? String(err.status) : undefined,
      retryable: isTransientError(err),
    });
    channel.send('message', { type: 'skill.ended', skillId, sessionKey });
  }
}

/** Legacy hardcoded setup tools (fallback when client doesn't inject config) */
function _legacySetupTools() {
  return [
    {
      name: 'setup_milestone',
      label: 'Setup Milestone',
      description: 'Report that a setup milestone has been reached.',
      parameters: Type.Object({ milestone: Type.String({ description: 'The milestone name' }) }),
      execute: async (_id, params) => {
        const m = params.milestone;
        if (SETUP_MILESTONES.includes(m)) {
          setupMilestonesReached.add(m);
          channel.send('message', { type: 'setup.milestone', milestone: m, completedCount: setupMilestonesReached.size });
        }
        return toToolResult({ success: true, milestone: m, completedCount: setupMilestonesReached.size });
      },
    },
    {
      name: 'setup_complete',
      label: 'Setup Complete',
      description: 'Complete the setup process.',
      parameters: Type.Object({
        shellName: Type.String({ description: 'The chosen name for the Shell' }),
        identity: Type.String({ description: 'Full IDENTITY.md content' }),
        memory: Type.String({ description: 'Full MEMORY.md content' }),
        soul: Type.String({ description: 'Full SOUL.md content' }),
      }),
      execute: async (_id, params) => {
        const workspaceDir = join(OPENCLAW_ROOT, 'workspace');
        mkdirSync(workspaceDir, { recursive: true });
        atomicWrite(join(workspaceDir, 'IDENTITY.md'), params.identity);
        atomicWrite(join(workspaceDir, 'MEMORY.md'), params.memory);
        atomicWrite(join(workspaceDir, 'SOUL.md'), params.soul);
        channel.send('message', {
          type: 'setup.complete', shellName: params.shellName,
          files: { 'IDENTITY.md': params.identity, 'MEMORY.md': params.memory, 'SOUL.md': params.soul },
        });
        return toToolResult({ success: true, shellName: params.shellName });
      },
    },
  ];
}

// ── Message handler ───────────────────────────────────────────────────────
// NOTE: agent.start / agent.stop / agent.retry / agent.steer are handled by
// the WebView-side AgentRunner (src/agent/agent-runner.ts). The worker now
// only handles tool.execute proxying, auth, system_prompt, skills, heartbeat,
// session queries, config, and cron.

channel.addListener('message', async (event) => {
  const msg = event;
  console.error(`[DEBUG] << RECV msg type=${msg?.type} keys=${Object.keys(msg||{}).join(',')}`);

  switch (msg.type) {
    // agent.start, agent.stop, agent.retry, agent.steer are handled by
    // WebView-side AgentRunner — no longer processed here.

    case 'tool.pre_execute.result': {
      const resolver = pendingPreExecuteHooks.get(msg.toolCallId);
      if (resolver) {
        pendingPreExecuteHooks.delete(msg.toolCallId);
        resolver({ args: msg.args, deny: msg.deny, denyReason: msg.denyReason });
      }
      break;
    }

    case 'skill.tool_result': {
      // Client resolved a waiting bridgeEvent tool (e.g. accounts_start_oauth after user taps "Connect")
      const resolver = pendingSkillToolResults.get(msg.requestId);
      if (resolver) {
        pendingSkillToolResults.delete(msg.requestId);
        resolver(msg.result);
      }
      break;
    }

    case 'skill.start': {
      console.error(`[DEBUG] skill.start: skill=${msg.skill} agentId=${msg.agentId} locale=${msg.locale}`);
      const agentId = msg.agentId || 'main';
      const locale = msg.locale || 'en';
      await runSkill(agentId, locale, msg.config || null);
      console.error(`[DEBUG] skill.start completed`);
      break;
    }

    case 'oauth.exchange': {
      // Perform OAuth token exchange in Node.js (bypasses Capacitor HTTP / CORS)
      const { tokenUrl, body, contentType } = msg;
      const useForm = (contentType || 'application/x-www-form-urlencoded') === 'application/x-www-form-urlencoded';
      try {
        const resp = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': useForm ? 'application/x-www-form-urlencoded' : 'application/json' },
          body: useForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
        });
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        channel.send('message', {
          type: 'oauth.exchange.result',
          success: resp.ok,
          status: resp.status,
          data,
          text: resp.ok ? undefined : text,
        });
      } catch (err) {
        channel.send('message', {
          type: 'oauth.exchange.result',
          success: false,
          error: err.message,
        });
      }
      break;
    }

    case 'mcp.tools.invalidate': {
      // MCP server restarted with new tools (e.g. after account connection).
      // Increment epoch first so any in-flight discoverMcpTools() discards its result.
      discoveryEpoch++;
      cachedMcpTools = null;
      discoveryPromise = null;
      // If an agent is running, re-discover and inject the updated tool set
      if (currentAgent) {
        try {
          const localTools = wrapToolsWithPreExecuteHook(buildAgentTools());
          const mcpTools = wrapToolsWithPreExecuteHook(await discoverMcpTools());
          const tools = [...localTools, ...mcpTools];
          currentAgent.setTools(tools);
          console.log(`[mobile-claw] Tools invalidated and refreshed: ${tools.length} total (${mcpTools.length} MCP)`);
        } catch (err) {
          console.warn(`[mobile-claw] Tool refresh failed: ${err.message}`);
        }
      } else {
        console.log('[mobile-claw] MCP tool cache invalidated (no active agent)');
      }
      break;
    }

    case 'config.update': {
      const { action, provider, apiKey, model } = msg.config;
      if (action === 'setApiKey') {
        const profiles = loadAuthProfiles('main');
        const profileKey = `${provider}:default`;
        profiles.profiles[profileKey] = {
          type: 'api_key',
          provider,
          key: apiKey,
        };
        profiles.lastGood = profiles.lastGood || {};
        profiles.lastGood[provider] = profileKey;
        saveAuthProfiles('main', profiles);
        channel.send('message', { type: 'config.update.result', success: true });
      } else if (action === 'setOAuth') {
        const profiles = loadAuthProfiles('main');
        const profileKey = `${provider}:oauth`;
        profiles.profiles[profileKey] = {
          type: 'oauth',
          provider,
          access: msg.config.accessToken,
          refresh: msg.config.refreshToken,
          expiresAt: msg.config.expiresAt,
        };
        profiles.lastGood = profiles.lastGood || {};
        profiles.lastGood[provider] = profileKey;
        saveAuthProfiles('main', profiles);
        channel.send('message', { type: 'config.update.result', success: true });
      }
      break;
    }

    case 'file.read': {
      const result = readFileTool({ path: msg.path });
      channel.send('message', {
        type: 'file.read.result',
        path: msg.path,
        content: result.content || '',
        error: result.error,
      });
      break;
    }

    case 'file.write': {
      writeFileTool({ path: msg.path, content: msg.content });
      break;
    }

    case 'config.status': {
      const statusProvider = msg.provider || 'anthropic';
      const profiles = loadAuthProfiles('main');
      let hasKey = false;
      let masked = '';
      for (const [, profile] of Object.entries(profiles.profiles)) {
        if (profile.provider === statusProvider) {
          const key = profile.key || profile.access || '';
          if (key) {
            hasKey = true;
            masked = key.length > 11
              ? key.substring(0, 7) + '***' + key.substring(key.length - 4)
              : '***';
            break;
          }
        }
      }
      channel.send('message', { type: 'config.status.result', hasKey, masked, provider: statusProvider });
      break;
    }

    case 'config.models': {
      const CURATED_MODELS = {
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
      };
      const reqProvider = msg.provider || 'anthropic';
      const models = CURATED_MODELS[reqProvider] || CURATED_MODELS.anthropic;
      channel.send('message', { type: 'config.models.result', models });
      break;
    }

    case 'heartbeat.wake': {
      await handleHeartbeatWake(msg.source || 'manual');
      break;
    }

    case 'heartbeat.set': {
      try {
        const heartbeat = await setHeartbeatConfig(msg.config || {});
        channel.send('message', {
          type: 'heartbeat.set.result',
          success: true,
          heartbeat,
        });
      } catch (err) {
        channel.send('message', {
          type: 'heartbeat.set.result',
          success: false,
          error: err.message,
        });
      }
      break;
    }

    case 'scheduler.set': {
      try {
        const scheduler = await setSchedulerConfig(msg.config || {});
        channel.send('message', {
          type: 'scheduler.set.result',
          success: true,
          scheduler,
        });
      } catch (err) {
        channel.send('message', {
          type: 'scheduler.set.result',
          success: false,
          error: err.message,
        });
      }
      break;
    }

    case 'scheduler.get': {
      try {
        const scheduler = await getSchedulerConfig();
        const heartbeat = await getHeartbeatConfig();
        channel.send('message', {
          type: 'scheduler.get.result',
          scheduler,
          heartbeat,
        });
      } catch (err) {
        channel.send('message', {
          type: 'scheduler.get.result',
          scheduler: { enabled: false },
          heartbeat: { enabled: false },
          error: err.message,
        });
      }
      break;
    }

    case 'cron.job.add': {
      try {
        const job = await addCronJob(msg.job || {});
        channel.send('message', { type: 'cron.job.add.result', success: true, job });
      } catch (err) {
        channel.send('message', { type: 'cron.job.add.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.job.update': {
      try {
        await updateCronJob(msg.id, msg.patch || {});
        channel.send('message', { type: 'cron.job.update.result', success: true });
      } catch (err) {
        channel.send('message', { type: 'cron.job.update.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.job.remove': {
      try {
        await removeCronJob(msg.id);
        channel.send('message', { type: 'cron.job.remove.result', success: true });
      } catch (err) {
        channel.send('message', { type: 'cron.job.remove.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.job.list': {
      const jobs = await listCronJobs();
      channel.send('message', { type: 'cron.job.list.result', jobs });
      break;
    }

    case 'cron.job.run': {
      await handleHeartbeatWake('manual', { force: true, forceJobId: msg.id });
      channel.send('message', { type: 'cron.job.run.result', success: true, id: msg.id });
      break;
    }

    case 'cron.runs.list': {
      const runs = await listCronRuns(msg.jobId, msg.limit);
      channel.send('message', { type: 'cron.runs.list.result', runs });
      break;
    }

    case 'cron.skill.add': {
      try {
        const skill = await addCronSkill(msg.skill || {});
        channel.send('message', { type: 'cron.skill.add.result', success: true, skill });
      } catch (err) {
        channel.send('message', { type: 'cron.skill.add.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.skill.update': {
      try {
        await updateCronSkill(msg.id, msg.patch || {});
        channel.send('message', { type: 'cron.skill.update.result', success: true });
      } catch (err) {
        channel.send('message', { type: 'cron.skill.update.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.skill.remove': {
      try {
        await removeCronSkill(msg.id);
        channel.send('message', { type: 'cron.skill.remove.result', success: true });
      } catch (err) {
        channel.send('message', { type: 'cron.skill.remove.result', success: false, error: err.message });
      }
      break;
    }

    case 'cron.skill.list': {
      const skills = await listCronSkills();
      channel.send('message', { type: 'cron.skill.list.result', skills });
      break;
    }

    case 'session.list': {
      const agentId = msg.agentId || 'main';
      let sessions = [];
      try {
        const rows = await dbQuery(
          'SELECT session_key, agent_id, created_at, updated_at, model, total_tokens FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC',
          [agentId]
        );
        sessions = rows.map(s => ({
          sessionKey: s.session_key,
          sessionId: s.session_key,
          updatedAt: s.updated_at || s.created_at || 0,
          model: s.model,
          totalTokens: s.total_tokens,
        }));
      } catch (err) {
        console.warn(`[session.list] SQLite query failed: ${err.message}`);
      }
      channel.send('message', { type: 'session.list.result', agentId, sessions });
      break;
    }

    case 'session.clear': {
      // Clears in-memory state; JSONL transcripts are preserved for history
      currentAgent = null;
      currentSessionKey = null;
      currentAbortController = null;
      persistedMessageCount = 0;
      channel.send('message', { type: 'session.clear.result', success: true });
      break;
    }

    case 'session.latest': {
      const agentId = msg.agentId || 'main';
      let latest = null;
      try {
        const row = await dbQueryOne(
          'SELECT session_key, created_at, updated_at, model, total_tokens FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1',
          [agentId]
        );
        if (row) {
          latest = {
            sessionId: row.session_key,
            sessionKey: row.session_key,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            model: row.model,
            totalTokens: row.total_tokens,
          };
        }
      } catch (err) {
        console.warn(`[session.latest] SQLite query failed: ${err.message}`);
      }
      channel.send('message', {
        type: 'session.latest.result',
        sessionKey: latest?.sessionId || latest?.sessionKey || null,
        session: latest,
      });
      break;
    }

    case 'session.load': {
      const agentId = msg.agentId || 'main';
      const sessionKey = msg.sessionKey;
      if (!sessionKey) {
        channel.send('message', { type: 'session.load.result', error: 'No sessionKey provided', messages: [] });
        break;
      }

      let rawMessages = null;
      try {
        const rows = await dbQuery(
          'SELECT role, content, timestamp, model, tool_call_id, usage_input, usage_output FROM messages WHERE session_key = ? ORDER BY sequence',
          [sessionKey]
        );
        if (rows.length > 0) {
          rawMessages = rows.map(r => ({
            role: r.role,
            content: _parseJsonSafe(r.content),
            timestamp: r.timestamp,
            model: r.model,
            toolCallId: r.tool_call_id,
            usage: (r.usage_input || r.usage_output) ? { input: r.usage_input, output: r.usage_output } : undefined,
          }));
        }
      } catch (err) {
        console.warn(`[session.load] SQLite query failed: ${err.message}`);
      }

      if (!rawMessages) {
        channel.send('message', { type: 'session.load.result', sessionKey, error: 'Session not found', messages: [] });
        break;
      }

      // Convert to UI message format
      let uiMessages = _convertToUiMessages(rawMessages);
      // For setup sessions, drop the synthetic kickoff prompt (first user message)
      if (sessionKey.startsWith('setup/') && uiMessages.length > 0 && uiMessages[0].role === 'user') {
        uiMessages = uiMessages.slice(1);
      }
      channel.send('message', { type: 'session.load.result', sessionKey, messages: uiMessages });
      break;
    }

    case 'session.resume': {
      // Restores conversation context: creates Agent, hydrates with saved messages
      const agentId = msg.agentId || 'main';
      const sessionKey = msg.sessionKey;
      if (!sessionKey) {
        channel.send('message', { type: 'session.resume.result', error: 'No sessionKey provided' });
        break;
      }

      const authProfiles = loadAuthProfiles(agentId);
      const apiKey = resolveApiKey(authProfiles);
      if (!apiKey) {
        channel.send('message', { type: 'session.resume.result', error: 'No API key configured' });
        break;
      }

      try {
        let agentMessages = null;
        try {
          const rows = await dbQuery(
            'SELECT role, content, timestamp, model, tool_call_id, usage_input, usage_output FROM messages WHERE session_key = ? ORDER BY sequence',
            [sessionKey]
          );
          if (rows.length > 0) {
            agentMessages = rows.map(r => ({
              role: r.role,
              content: _parseJsonSafe(r.content),
              timestamp: r.timestamp,
              model: r.model,
              toolCallId: r.tool_call_id,
              usage: (r.usage_input || r.usage_output) ? { input: r.usage_input, output: r.usage_output } : undefined,
            }));
          }
        } catch (err) {
          console.warn(`[session.resume] SQLite query failed: ${err.message}`);
        }

        if (!agentMessages) {
          channel.send('message', { type: 'session.resume.result', error: 'Session not found' });
          break;
        }

        const systemPrompt = loadSystemPrompt();
        const model = getModel('anthropic', 'claude-sonnet-4-5');

        const localTools = wrapToolsWithPreExecuteHook(buildAgentTools());
        const mcpTools = wrapToolsWithPreExecuteHook(await discoverMcpTools());
        const tools = [...localTools, ...mcpTools];

        const agent = new Agent({
          initialState: { systemPrompt, model, tools, thinkingLevel: 'off' },
          convertToLlm: (messages) => messages.filter(m =>
            m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
          ),
          getApiKey: () => apiKey,
        });

        agent.replaceMessages(agentMessages);
        agent.subscribe((event) => { bridgeEvent(event); });

        currentAgent = agent;
        currentSessionKey = sessionKey;
        persistedMessageCount = agentMessages.length;

        channel.send('message', {
          type: 'session.resume.result',
          sessionKey,
          messageCount: agentMessages.length,
          success: true,
        });
      } catch (err) {
        channel.send('message', { type: 'session.resume.result', error: err.message });
      }
      break;
    }

    case 'tool.invoke': {
      // Direct tool invocation for E2E testing — bypasses LLM agent loop
      const toolMap = {
        read_file: readFileTool,
        write_file: writeFileTool,
        list_files: listFilesTool,
        grep_files: grepFilesTool,
        find_files: findFilesTool,
        edit_file: editFileTool,
        execute_js: executeJsTool,
        execute_python: executePythonTool,
        git_init: gitInitTool,
        git_status: gitStatusTool,
        git_add: gitAddTool,
        git_commit: gitCommitTool,
        git_log: gitLogTool,
        git_diff: gitDiffTool,
      };
      const fn = toolMap[msg.toolName];
      if (!fn) {
        // Fallback: try MCP device tool via bridge (e.g. device_get_info, clipboard_read)
        try {
          const mcpResult = await mcpBridge.callTool(msg.toolName, msg.args || {});
          channel.send('message', { type: 'tool.invoke.result', toolName: msg.toolName, result: mcpResult });
        } catch (mcpErr) {
          channel.send('message', { type: 'tool.invoke.result', toolName: msg.toolName, error: mcpErr.message });
        }
      } else {
        try {
          const result = await fn(msg.args || {});
          channel.send('message', { type: 'tool.invoke.result', toolName: msg.toolName, result });
        } catch (err) {
          channel.send('message', { type: 'tool.invoke.result', toolName: msg.toolName, error: err.message });
        }
      }
      break;
    }

    case 'tool.execute': {
      // WebView-side agent runner proxies tool calls to the worker.
      // This is the counterpart to ToolProxy in src/agent/tool-proxy.ts.
      const toolExecMap = {
        read_file: readFileTool,
        write_file: writeFileTool,
        list_files: listFilesTool,
        grep_files: grepFilesTool,
        find_files: findFilesTool,
        edit_file: editFileTool,
        execute_js: executeJsTool,
        execute_python: executePythonTool,
        git_init: gitInitTool,
        git_status: gitStatusTool,
        git_add: gitAddTool,
        git_commit: gitCommitTool,
        git_log: gitLogTool,
        git_diff: gitDiffTool,
      };
      const toolFn = toolExecMap[msg.toolName];
      if (!toolFn) {
        channel.send('message', {
          type: 'tool.execute.result',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          error: `Unknown tool: ${msg.toolName}`,
        });
      } else {
        try {
          const result = await toolFn(msg.args || {});
          channel.send('message', {
            type: 'tool.execute.result',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result,
          });
        } catch (err) {
          channel.send('message', {
            type: 'tool.execute.result',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            error: err.message,
          });
        }
      }
      break;
    }

    case 'auth.getToken': {
      // WebView-side agent runner requests auth credentials
      const agentId = msg.agentId || 'main';
      const provider = msg.provider || 'anthropic';
      try {
        await refreshOAuthTokenIfNeeded(agentId);
      } catch (e) {
        console.warn(`[auth.getToken] OAuth refresh failed: ${e.message}`);
      }
      const authProfiles = loadAuthProfiles(agentId);
      const apiKey = resolveApiKeyForProvider(authProfiles, provider);
      // Check if the resolved key is an OAuth token
      const isOAuth = apiKey ? apiKey.startsWith('sk-ant-oat') : false;
      channel.send('message', {
        type: 'auth.getToken.result',
        apiKey: apiKey || null,
        isOAuth,
      });
      break;
    }

    case 'system_prompt.get': {
      // WebView-side agent runner requests the system prompt
      const sysPrompt = loadSystemPrompt();
      channel.send('message', {
        type: 'system_prompt.get.result',
        systemPrompt: sysPrompt,
      });
      break;
    }

    case 'webview_trace': {
      console.error(`[WEBVIEW] ${msg.label}`);
      break;
    }

    case 'status_ping': {
      // iOS race condition: the WebView registered its listener after worker.ready
      // was already sent.  Re-emit so the engine can pick it up.
      console.error(`[DEBUG] status_ping received — re-emitting worker.ready`);
      channel.send('message', {
        type: 'worker.ready',
        nodeVersion: process.version,
        openclawRoot: OPENCLAW_ROOT,
        mcpToolCount: 0,
      });
      break;
    }

    default:
      console.error(`[DEBUG] Unknown message type: ${msg.type}`);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

console.error(`[DEBUG] Starting init sequence...`);
console.error(`[DEBUG] OPENCLAW_ROOT=${OPENCLAW_ROOT}`);
console.error(`[DEBUG] DATADIR=${process.env.DATADIR || '(unset)'}, HOME=${process.env.HOME || '(unset)'}`);
ensureOpenClawDirs();
console.error(`[DEBUG] Dirs ensured. Sending worker.loading_phase=engine`);
channel.send('message', { type: 'worker.loading_phase', phase: 'engine' });

// Initialize native SQLite via bridge, migrate legacy JSONL data, then signal ready
initWorkerDb(OPENCLAW_ROOT, channel).then(async () => {
  channel.send('message', { type: 'worker.loading_phase', phase: 'database' });
  channel.send('message', { type: 'worker.db_status', ready: true });
  // Migrate existing JSONL sessions into native SQLite (one-time, idempotent)
  try {
    await migrateFromJsonl(OPENCLAW_ROOT, 'main');
  } catch (err) {
    console.warn(`[init] JSONL migration failed (non-fatal): ${err.message}`);
  }
}).catch(err => {
  console.error(`[DEBUG] Native SQLite init failed: ${err.message}`);
  channel.send('message', { type: 'worker.db_status', ready: false, error: err.message });
}).finally(() => {
  try {
    console.error(`[DEBUG] .finally() entered — sending worker.ready`);
    channel.send('message', {
      type: 'worker.ready',
      nodeVersion: process.version,
      openclawRoot: OPENCLAW_ROOT,
      mcpToolCount: 0,
    });
    console.error(`[DEBUG] worker.ready SENT. Node=${process.version} root=${OPENCLAW_ROOT}`);

    initHeartbeat({
      channel,
      buildAutoApproveTools,
      discoverMcpTools,
      getCurrentAgent,
      getCurrentSessionKey,
      isUserTurnActive,
      resolveApiKey,
      loadAuthProfiles,
      loadSystemPrompt,
      getModel,
      refreshOAuthTokenIfNeeded,
      Agent,
      OPENCLAW_ROOT,
      persistCurrentSession,
    });

    // Pre-discover MCP device tools at startup (non-blocking, best-effort).
    channel.send('message', { type: 'worker.loading_phase', phase: 'tools' });
    discoverMcpTools().then(tools => {
      console.error(`[DEBUG] MCP discovery resolved: ${tools.length} tools`);
      if (tools.length > 0) {
        channel.send('message', {
          type: 'worker.tools_updated',
          mcpToolCount: tools.length,
        });
      }
      channel.send('message', { type: 'worker.loading_phase', phase: 'ready' });
      console.error(`[DEBUG] All loading phases complete — worker fully ready`);
    }).catch((mcpErr) => {
      console.error(`[DEBUG] MCP discovery FAILED: ${mcpErr?.message || mcpErr}`);
      channel.send('message', { type: 'worker.loading_phase', phase: 'ready' });
    });
  } catch (finallyErr) {
    console.error(`[DEBUG] FATAL in .finally(): ${finallyErr?.message || finallyErr}`);
    console.error(finallyErr?.stack || '(no stack)');
  }
});
