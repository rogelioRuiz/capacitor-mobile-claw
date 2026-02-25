/**
 * mobile-claw Node.js worker entry point.
 *
 * Runs inside the embedded Node.js runtime provided by Capacitor-NodeJS.
 * Communicates with the Capacitor WebView UI via the bridge channel.
 *
 * Responsibilities:
 * - Agent orchestration (pi-agent-core Agent class)
 * - LLM API calls (pi-ai streaming)
 * - File tools (read/write/edit/find/grep/ls)
 * - Code execution (JS VM sandbox + Python Pyodide sandbox)
 * - Git tools (isomorphic-git)
 * - Pre-execution hook (tool.pre_execute — consumer controls approval policy)
 * - Session management (JSONL transcripts)
 * - Auth profile management (auth-profiles.json)
 */

// ── Node.js v18 polyfills (Capacitor-NodeJS ships v18.20.4) ──────────────
// undici and Anthropic SDK expect globals that only exist in Node.js >=20.
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

import { resolve, join } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';

// ── SQLite persistence layer ──────────────────────────────────────────────
import {
  initWorkerDb, isDbReady,
  run as dbRun, query as dbQuery, queryOne as dbQueryOne,
  transaction as dbTransaction, flush as dbFlush,
  migrateFromJsonl, atomicWrite,
} from './worker-db.js';

// ── MCP bridge (device tools from WebView) ────────────────────────────────
import { initMcpBridge } from './mcp-bridge-client.js';
import { buildMcpAgentTools } from './mcp-agent-tools.js';

const mcpBridge = initMcpBridge(channel);

// Cache for discovered MCP tools — avoids re-discovery on every agent run
let cachedMcpTools = null;

/**
 * Discover MCP device tools from the WebView server.
 * Returns AgentTool[] or empty array if bridge is not available.
 * Uses a 3-second timeout for graceful degradation.
 */
async function discoverMcpTools() {
  if (cachedMcpTools) return cachedMcpTools;

  try {
    const mcpToolDescriptors = await Promise.race([
      mcpBridge.listTools(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);

    const rawTools = buildMcpAgentTools(mcpBridge, mcpToolDescriptors);

    // Wrap each MCP tool with the pre-execute hook (consumer decides approval policy)
    cachedMcpTools = rawTools.map(tool => ({
      ...tool,
      execute: wrapWithPreExecuteHook(tool.name, tool.execute),
    }));

    console.log(`[mobile-claw] Discovered ${cachedMcpTools.length} MCP device tools`);
    return cachedMcpTools;
  } catch (err) {
    console.warn(`[mobile-claw] MCP bridge not available, using local tools only: ${err.message}`);
    return [];
  }
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
  // Prefer lastGood profile if set
  const lastGoodKey = authProfiles.lastGood?.anthropic;
  if (lastGoodKey && authProfiles.profiles[lastGoodKey]) {
    const p = authProfiles.profiles[lastGoodKey];
    if (p.type === 'oauth' && p.access) return p.access;
    if (p.type === 'api_key' && p.key) return p.key;
  }
  // Fallback: prefer OAuth over api_key
  let fallbackApiKey = null;
  for (const [, profile] of Object.entries(authProfiles.profiles)) {
    if (profile.provider === 'anthropic' && profile.type === 'oauth' && profile.access) {
      return profile.access;
    }
    if (profile.provider === 'anthropic' && profile.type === 'api_key' && profile.key && !fallbackApiKey) {
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
      const resp = await fetch('https://platform.claude.com/v1/oauth/token', {
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

import { loadPyodide } from 'pyodide';

let pyodideInstance = null;

async function getPyodide() {
  if (!pyodideInstance) {
    pyodideInstance = await loadPyodide();
    // Block dangerous modules for sandbox security
    pyodideInstance.runPython(`
import sys
for _mod in ['subprocess', 'socket', 'http', 'urllib', 'ftplib', 'smtplib',
             'webbrowser', 'ctypes', 'multiprocessing', 'shutil', 'tempfile',
             'signal', 'resource']:
    sys.modules[_mod] = None
del _mod
`);
  }
  return pyodideInstance;
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

// Idempotency: track recent message keys to silently drop duplicates
const recentIdempotencyKeys = new Set();
const MAX_IDEMPOTENCY_KEYS = 100;

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

  // Wrap all tools with pre-execute hook (consumer decides approval policy)
  return toolDefs.map(tool => ({
    ...tool,
    execute: wrapWithPreExecuteHook(tool.name, tool.execute),
  }));
}

// ── AgentEvent → Bridge event mapping ────────────────────────────────────

function bridgeEvent(event) {
  switch (event.type) {
    case 'message_update': {
      const e = event.assistantMessageEvent;
      if (e.type === 'text_delta') {
        channel.send('message', { type: 'agent.event', eventType: 'text_delta', data: { text: e.delta } });
      }
      if (e.type === 'thinking_delta') {
        channel.send('message', { type: 'agent.event', eventType: 'thinking', data: { text: e.delta } });
      }
      break;
    }
    case 'tool_execution_start':
      channel.send('message', {
        type: 'agent.event',
        eventType: 'tool_use',
        data: { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
      });
      break;
    case 'tool_execution_end':
      channel.send('message', {
        type: 'agent.event',
        eventType: 'tool_result',
        data: { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
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

// Deduplicate messages loaded from JSONL (handles legacy duplication bug)
function deduplicateMessages(messages) {
  const seen = new Set();
  return messages.filter(m => {
    const contentKey = typeof m.content === 'string'
      ? m.content.substring(0, 100)
      : JSON.stringify(m.content).substring(0, 100);
    const key = `${m.role}:${m.timestamp || ''}:${contentKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Rebuild sessions.json index from JSONL files on disk (recovery path)
function rebuildSessionIndex(agentId) {
  const sessionsDir = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
  try {
    const jsonlFiles = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    const index = { [agentId]: {} };
    for (const file of jsonlFiles) {
      const sessionKey = file.replace('.jsonl', '').replace('_', '/');
      const stat = statSync(join(sessionsDir, file));
      index[agentId][sessionKey] = {
        sessionId: sessionKey,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: stat.mtimeMs,
        model: 'anthropic/claude-sonnet-4-5',
        totalTokens: 0,
      };
    }
    console.log(`[rebuildSessionIndex] Rebuilt index with ${jsonlFiles.length} sessions`);
    return index;
  } catch {
    return { [agentId]: {} };
  }
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

function saveSession(agent, agentId, sessionKey, startTime) {
  if (!isDbReady()) {
    // Fallback to JSONL if DB not ready (should not happen in normal flow)
    _saveSessionJsonlFallback(agent, agentId, sessionKey, startTime);
    return;
  }

  const allMessages = agent.state.messages;
  const usage = extractUsage(agent);

  try {
    dbTransaction(() => {
      // Persist new messages since last save
      for (let i = persistedMessageCount; i < allMessages.length; i++) {
        const m = allMessages[i];
        dbRun(
          `INSERT OR IGNORE INTO messages
           (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionKey, i, m.role,
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            m.timestamp || null, m.model || null, m.toolCallId || null,
            m.usage?.input || null, m.usage?.output || null,
          ]
        );
      }

      // Update session metadata atomically with messages
      dbRun(
        `INSERT OR REPLACE INTO sessions
         (session_key, agent_id, created_at, updated_at, model, total_tokens, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionKey, agentId, startTime, Date.now(),
          'anthropic/claude-sonnet-4-5', usage.totalTokens,
          usage.inputTokens, usage.outputTokens,
        ]
      );
    });

    persistedMessageCount = allMessages.length;
    dbFlush(); // Atomic write to disk — survives OOM kill
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

// Legacy fallback — only used if SQLite init fails
function _saveSessionJsonlFallback(agent, agentId, sessionKey, startTime) {
  const sessionsDir = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
  const sessionFile = join(sessionsDir, `${sessionKey.replace('/', '_')}.jsonl`);
  const allMessages = agent.state.messages;
  for (let i = persistedMessageCount; i < allMessages.length; i++) {
    nodeFs.appendFileSync(sessionFile, JSON.stringify(allMessages[i]) + '\n');
  }
  persistedMessageCount = allMessages.length;
  const usage = extractUsage(agent);
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  try {
    let index = {};
    try { index = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')); } catch {
      index = rebuildSessionIndex(agentId);
    }
    if (!index[agentId]) index[agentId] = {};
    index[agentId][sessionKey] = {
      sessionId: sessionKey, createdAt: startTime, updatedAt: Date.now(),
      model: 'anthropic/claude-sonnet-4-5', totalTokens: usage.totalTokens,
    };
    const tmpPath = sessionsJsonPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(index, null, 2));
    renameSync(tmpPath, sessionsJsonPath);
  } catch { /* non-fatal */ }
}

// ── Mid-turn checkpoint helper ────────────────────────────────────────────

function _checkpointMessages(agent, agentId, sessionKey) {
  if (!isDbReady()) {
    // Fallback: append to JSONL
    try {
      const sessionsDir = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = join(sessionsDir, `${sessionKey.replace('/', '_')}.jsonl`);
      const allMessages = agent.state.messages;
      for (let i = persistedMessageCount; i < allMessages.length; i++) {
        nodeFs.appendFileSync(sessionFile, JSON.stringify(allMessages[i]) + '\n');
      }
      persistedMessageCount = allMessages.length;
    } catch { /* non-fatal */ }
    return;
  }

  try {
    const allMessages = agent.state.messages;
    if (persistedMessageCount >= allMessages.length) return; // nothing new

    dbTransaction(() => {
      for (let i = persistedMessageCount; i < allMessages.length; i++) {
        const m = allMessages[i];
        dbRun(
          `INSERT OR IGNORE INTO messages
           (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionKey, i, m.role,
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            m.timestamp || null, m.model || null, m.toolCallId || null,
            m.usage?.input || null, m.usage?.output || null,
          ]
        );
      }
    });

    persistedMessageCount = allMessages.length;
    dbFlush(); // Atomic persist to disk
  } catch (err) {
    console.warn(`[checkpoint] SQLite checkpoint failed: ${err.message}`);
    // Do NOT increment persistedMessageCount — retry on next checkpoint
  }
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

    // bridgeEvent tools — emit tool input as a bridge message to the UI
    if (toolDef.bridgeEvent) {
      const eventType = toolDef.bridgeEvent;
      base.execute = async (_id, params) => {
        channel.send('message', { type: eventType, ...params });
        return toToolResult({ success: true, applied: true });
      };
      return base;
    }

    // Generic fallback
    base.execute = async (_id, params) => toToolResult(params);
    return base;
  });
}

async function runSetupSkill(agentId, locale = 'en', injectedConfig = null) {
  await refreshOAuthTokenIfNeeded(agentId);
  const authProfiles = loadAuthProfiles(agentId);
  const apiKey = resolveApiKey(authProfiles);

  if (!apiKey) {
    channel.send('message', {
      type: 'agent.error',
      error: 'No AI provider configured. Connect a provider first.',
    });
    return;
  }

  const modelId = 'claude-sonnet-4-5';
  const model = getModel('anthropic', modelId);

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
  const tools = [...setupTools, ...filteredBase, ...filteredMcp];

  const sessionKey = `setup/${Date.now()}`;
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
    bridgeEvent(event);
    if (event.type === 'tool_execution_end' && sessionKey) {
      _checkpointMessages(agent, agentId, sessionKey);
    }
  });

  const startTime = Date.now();
  try {
    await agent.prompt(kickoff);
    await agent.waitForIdle();

    saveSession(agent, agentId, sessionKey, startTime);

    const usage = extractUsage(agent);
    channel.send('message', {
      type: 'agent.completed',
      sessionKey,
      usage,
      cumulativeUsage: usage,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    channel.send('message', {
      type: 'agent.error',
      error: err.message || 'Setup skill error',
      code: err.status ? String(err.status) : undefined,
      retryable: isTransientError(err),
    });
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

// ── Main agent run function ──────────────────────────────────────────────

async function runAgentLoop(agentId, sessionKey, prompt, requestedModel) {
  await refreshOAuthTokenIfNeeded(agentId);
  const authProfiles = loadAuthProfiles(agentId);
  const apiKey = resolveApiKey(authProfiles);

  if (!apiKey) {
    channel.send('message', {
      type: 'agent.error',
      error: 'No Anthropic API key configured. Go to Settings to add one.',
    });
    return;
  }

  const systemPrompt = loadSystemPrompt();
  const modelId = requestedModel || 'claude-sonnet-4-5';
  const model = getModel('anthropic', modelId);

  // Merge local tools with MCP device tools (if bridge is available)
  const localTools = buildAgentTools();
  const mcpTools = await discoverMcpTools();
  const tools = [...localTools, ...mcpTools];

  // Create Agent instance
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
  persistedMessageCount = 0;

  // Subscribe to events → bridge channel + mid-turn checkpointing
  agent.subscribe((event) => {
    bridgeEvent(event);
    // Checkpoint after each tool execution (crash loses at most the current tool call)
    if (event.type === 'tool_execution_end' && sessionKey) {
      _checkpointMessages(agent, agentId, sessionKey);
    }
  });

  // Run
  const startTime = Date.now();
  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();

    // Save session + send completion
    currentSessionKey = sessionKey;
    saveSession(agent, agentId, sessionKey, startTime);

    const usage = extractUsage(agent);
    channel.send('message', {
      type: 'agent.completed',
      sessionKey,
      usage,
      cumulativeUsage: usage,
      durationMs: Date.now() - startTime,
    });
    // Keep currentAgent alive for multi-turn follow-ups
    currentAbortController = null;
  } catch (err) {
    const retryable = isTransientError(err);
    channel.send('message', {
      type: 'agent.error',
      error: err.message || 'Unknown error during agent execution',
      code: err.status ? String(err.status) : undefined,
      retryable,
    });
    if (retryable) {
      // Keep agent alive for retry — only clear the abort controller
      lastFailedPrompt = prompt;
    } else {
      currentAgent = null;
      currentSessionKey = null;
      lastFailedPrompt = null;
    }
    currentAbortController = null;
  }
}

// ── Message handler ───────────────────────────────────────────────────────

channel.addListener('message', async (event) => {
  const msg = event;

  switch (msg.type) {
    case 'agent.start': {
      // Idempotency: silently drop duplicate messages
      if (msg.idempotencyKey) {
        if (recentIdempotencyKeys.has(msg.idempotencyKey)) break;
        recentIdempotencyKeys.add(msg.idempotencyKey);
        if (recentIdempotencyKeys.size > MAX_IDEMPOTENCY_KEYS) {
          const first = recentIdempotencyKeys.values().next().value;
          recentIdempotencyKeys.delete(first);
        }
      }

      // Echo user prompt back so the chat UI can display it
      channel.send('message', {
        type: 'agent.event',
        eventType: 'user_message',
        data: { text: msg.prompt, sessionKey: msg.sessionKey || currentSessionKey },
      });

      if (currentAgent && currentAgent.state.messages.length > 0) {
        // Continue existing conversation — use prompt() to re-enter the agent loop.
        // followUp() only enqueues; it doesn't re-enter _runLoop() on an idle agent.

        // Auto-abort in-flight turn before sending new message
        if (currentAgent.state.isStreaming) {
          currentAgent.abort();
          await currentAgent.waitForIdle();
          channel.send('message', {
            type: 'agent.event',
            eventType: 'interrupted',
            data: { reason: 'New message sent while streaming' },
          });
        }

        const startTime = Date.now();
        const agentId = msg.agentId || 'main';
        const sessionKey = currentSessionKey || msg.sessionKey;
        try {
          await currentAgent.prompt(msg.prompt);
          await currentAgent.waitForIdle();

          saveSession(currentAgent, agentId, sessionKey, startTime);

          const usage = extractUsage(currentAgent);
          channel.send('message', {
            type: 'agent.completed',
            sessionKey,
            usage,
            cumulativeUsage: usage,
            durationMs: Date.now() - startTime,
          });
        } catch (err) {
          const retryable = isTransientError(err);
          channel.send('message', {
            type: 'agent.error',
            error: err.message || 'Follow-up error',
            code: err.status ? String(err.status) : undefined,
            retryable,
          });
          if (retryable) {
            lastFailedPrompt = msg.prompt;
          } else {
            currentAgent = null;
            currentSessionKey = null;
            lastFailedPrompt = null;
          }
        }
      } else {
        // New conversation
        currentAbortController = new AbortController();
        await runAgentLoop(msg.agentId, msg.sessionKey, msg.prompt, msg.model);
      }
      break;
    }

    case 'agent.stop': {
      if (currentAgent) {
        currentAgent.abort();
      }
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      break;
    }

    case 'agent.retry': {
      // Retry last failed prompt (only works after a transient error)
      if (!currentAgent || !lastFailedPrompt) {
        channel.send('message', {
          type: 'agent.error',
          error: 'Nothing to retry — no agent or no failed prompt.',
          retryable: false,
        });
        break;
      }
      const retryPrompt = lastFailedPrompt;
      lastFailedPrompt = null;
      const retryAgentId = msg.agentId || 'main';
      const retrySessionKey = currentSessionKey || msg.sessionKey;
      const retryStart = Date.now();
      try {
        await currentAgent.prompt(retryPrompt);
        await currentAgent.waitForIdle();
        saveSession(currentAgent, retryAgentId, retrySessionKey, retryStart);
        const usage = extractUsage(currentAgent);
        channel.send('message', {
          type: 'agent.completed',
          sessionKey: retrySessionKey,
          usage,
          cumulativeUsage: usage,
          durationMs: Date.now() - retryStart,
        });
      } catch (err) {
        const retryable = isTransientError(err);
        channel.send('message', {
          type: 'agent.error',
          error: err.message || 'Retry failed',
          code: err.status ? String(err.status) : undefined,
          retryable,
        });
        if (retryable) {
          lastFailedPrompt = retryPrompt;
        } else {
          currentAgent = null;
          currentSessionKey = null;
          lastFailedPrompt = null;
        }
      }
      break;
    }

    case 'tool.pre_execute.result': {
      const resolver = pendingPreExecuteHooks.get(msg.toolCallId);
      if (resolver) {
        pendingPreExecuteHooks.delete(msg.toolCallId);
        resolver({ args: msg.args, deny: msg.deny, denyReason: msg.denyReason });
      }
      break;
    }

    case 'agent.steer': {
      if (currentAgent) {
        currentAgent.steer({ role: 'user', content: msg.text, timestamp: Date.now() });
      }
      break;
    }

    case 'skill.start': {
      if (msg.skill === 'setup') {
        const agentId = msg.agentId || 'main';
        const locale = msg.locale || 'en';
        await runSetupSkill(agentId, locale, msg.config || null);
      } else {
        channel.send('message', {
          type: 'agent.error',
          error: `Unknown skill: ${msg.skill}`,
        });
      }
      break;
    }

    case 'oauth.exchange': {
      // Perform OAuth token exchange in Node.js (bypasses Capacitor HTTP / CORS)
      const { tokenUrl, body } = msg;
      try {
        const resp = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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
      const profiles = loadAuthProfiles('main');
      let hasKey = false;
      let masked = '';
      for (const [, profile] of Object.entries(profiles.profiles)) {
        if (profile.provider === 'anthropic') {
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
      channel.send('message', { type: 'config.status.result', hasKey, masked });
      break;
    }

    case 'config.models': {
      const models = [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Fast and capable', default: true },
        { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5', description: 'Quick and lightweight' },
        { id: 'claude-opus-4', name: 'Claude Opus 4', description: 'Most capable' },
      ];
      channel.send('message', { type: 'config.models.result', models });
      break;
    }

    case 'session.list': {
      const agentId = msg.agentId || 'main';
      let sessions = [];
      if (isDbReady()) {
        try {
          sessions = dbQuery(
            'SELECT session_key, agent_id, created_at, updated_at, model, total_tokens FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC',
            [agentId]
          ).map(s => ({
            sessionKey: s.session_key,
            sessionId: s.session_key,
            updatedAt: s.updated_at || s.created_at || 0,
            model: s.model,
            totalTokens: s.total_tokens,
          }));
        } catch (err) {
          console.warn(`[session.list] SQLite query failed: ${err.message}`);
        }
      }
      // Fallback to sessions.json if SQLite empty or unavailable
      if (sessions.length === 0) {
        const sessionsJsonPath = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions', 'sessions.json');
        try {
          let raw;
          try { raw = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')); }
          catch { raw = rebuildSessionIndex(agentId); }
          const entries = raw[agentId] || raw;
          sessions = Object.values(entries)
            .filter(s => s && typeof s === 'object' && s.sessionId)
            .map(s => ({
              sessionKey: s.sessionId,
              sessionId: s.sessionId,
              updatedAt: s.updatedAt || s.createdAt || 0,
              model: s.model,
              totalTokens: s.totalTokens,
            }));
          sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        } catch { /* No sessions yet */ }
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
      if (isDbReady()) {
        try {
          const row = dbQueryOne(
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
        } catch { /* fall through to JSON fallback */ }
      }
      // Fallback to sessions.json if SQLite has nothing
      if (!latest) {
        const sessionsJsonPath = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions', 'sessions.json');
        try {
          let raw;
          try { raw = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')); }
          catch { raw = rebuildSessionIndex(agentId); }
          const entries = raw[agentId] || raw;
          const sorted = Object.values(entries)
            .filter(s => s && typeof s === 'object' && s.sessionId)
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          latest = sorted[0] || null;
        } catch { /* no sessions */ }
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

      // Try SQLite first
      if (isDbReady()) {
        try {
          const rows = dbQuery(
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
      }

      // Fallback to JSONL if SQLite has nothing
      if (!rawMessages) {
        const sessionsDir = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
        const sessionFile = join(sessionsDir, `${sessionKey.replace('/', '_')}.jsonl`);
        try {
          const raw = readFileSync(sessionFile, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim());
          const parsed = [];
          for (const line of lines) {
            try { parsed.push(JSON.parse(line)); }
            catch { console.warn(`[session.load] Skipping corrupted JSONL line: ${line.substring(0, 80)}`); }
          }
          rawMessages = deduplicateMessages(parsed);
        } catch (err) {
          channel.send('message', { type: 'session.load.result', sessionKey, error: err.message, messages: [] });
          break;
        }
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
        // Load messages from SQLite first, fallback to JSONL
        let agentMessages = null;
        if (isDbReady()) {
          try {
            const rows = dbQuery(
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
          } catch { /* fall through to JSONL */ }
        }

        if (!agentMessages) {
          const sessionsDir = join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
          const sessionFile = join(sessionsDir, `${sessionKey.replace('/', '_')}.jsonl`);
          const raw = readFileSync(sessionFile, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim());
          const rawMessages = [];
          for (const line of lines) {
            try { rawMessages.push(JSON.parse(line)); }
            catch { console.warn(`[session.resume] Skipping corrupted JSONL line`); }
          }
          agentMessages = deduplicateMessages(rawMessages);
        }

        const systemPrompt = loadSystemPrompt();
        const model = getModel('anthropic', 'claude-sonnet-4-5');

        const localTools = buildAgentTools();
        const mcpTools = await discoverMcpTools();
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

    default:
      console.log('[Worker] Unknown message type:', msg.type);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

ensureOpenClawDirs();

// Initialize SQLite, migrate legacy JSONL data, then start MCP discovery
initWorkerDb(OPENCLAW_ROOT).then(() => {
  // Migrate existing JSONL sessions into SQLite (one-time, idempotent)
  try {
    migrateFromJsonl(OPENCLAW_ROOT, 'main', deduplicateMessages);
  } catch (err) {
    console.warn(`[init] JSONL migration failed (non-fatal): ${err.message}`);
  }
}).catch(err => {
  console.warn(`[init] SQLite init failed, using JSONL fallback: ${err.message}`);
}).finally(() => {
  // Pre-discover MCP device tools at startup (non-blocking, best-effort).
  // Results are cached so the first agent run doesn't wait for discovery.
  discoverMcpTools().then(tools => {
    channel.send('message', {
      type: 'worker.ready',
      nodeVersion: process.version,
      openclawRoot: OPENCLAW_ROOT,
      mcpToolCount: tools.length,
    });
    console.log(`[mobile-claw worker] Ready. Node ${process.version}, root=${OPENCLAW_ROOT}, mcpTools=${tools.length}`);
  }).catch(() => {
    channel.send('message', {
      type: 'worker.ready',
      nodeVersion: process.version,
      openclawRoot: OPENCLAW_ROOT,
      mcpToolCount: 0,
    });
    console.log(`[mobile-claw worker] Ready (no MCP). Node ${process.version}, root=${OPENCLAW_ROOT}`);
  });
});
