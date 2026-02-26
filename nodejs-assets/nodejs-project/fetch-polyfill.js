/**
 * fetch() polyfill — replaces the broken undici-based built-in fetch.
 *
 * Capacitor-NodeJS ships Node.js v18.20.4 with --expose_wasm disabled.
 * The built-in fetch() uses undici whose HTTP parser (llhttp) requires WASM.
 * This module provides a native https/http implementation.
 *
 * MUST be imported before ANY other module that might call fetch().
 */

// ── WebAssembly stub ────────────────────────────────────────────────────
// Provide a minimal WebAssembly global so undici's lazyllhttp doesn't crash
// with "ReferenceError: WebAssembly is not defined". The stub lets the
// internal module graph load without error, but we replace fetch anyway.
if (typeof globalThis.WebAssembly === 'undefined') {
  class _WasmError extends Error { constructor(msg) { super(msg); this.name = this.constructor.name; } }
  class RuntimeError extends _WasmError {}
  class CompileError extends _WasmError {}
  class LinkError extends _WasmError {}

  const _noWasm = (name) => { throw new CompileError(`WebAssembly.${name}() is not available (WASM disabled)`); };

  globalThis.WebAssembly = {
    // All compilation/instantiation methods throw CompileError so callers
    // (sql.js, undici, pyodide) fall into their error/catch handlers cleanly.
    compile: async () => _noWasm('compile'),
    instantiate: async () => _noWasm('instantiate'),
    instantiateStreaming: async () => _noWasm('instantiateStreaming'),
    compileStreaming: async () => _noWasm('compileStreaming'),
    validate: () => false,
    Module: class Module { constructor() { _noWasm('Module'); } },
    Instance: class Instance { constructor() { _noWasm('Instance'); } },
    Memory: class Memory { constructor() { _noWasm('Memory'); } },
    Table: class Table { constructor() { _noWasm('Table'); } },
    Global: class Global { constructor() { _noWasm('Global'); } },
    RuntimeError,
    CompileError,
    LinkError,
  };
  // Mark as stub so other modules can detect it
  globalThis.WebAssembly._isStub = true;
  // Catch unhandled rejections from lazy undici WASM compilation attempts.
  // Node.js v18's built-in fetch triggers undici's lazyllhttp which calls
  // WebAssembly.compile() — our stub rejects it, but the error may propagate
  // as an unhandled rejection and crash the process. Suppress these errors.
  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (msg.includes('WASM disabled') || msg.includes('WebAssembly') ||
        reason instanceof CompileError || reason instanceof _WasmError) {
      // Silently swallow — we replace fetch with our native polyfill anyway
      return;
    }
    // Let other unhandled rejections through to default handler
    console.error('[unhandledRejection]', reason);
  });

  console.log('[fetch-polyfill] Installed WebAssembly stub (WASM disabled in this runtime)');
}

import * as _https from 'node:https';
import * as _http from 'node:http';
import { Readable } from 'node:stream';

class _Headers {
  #map = new Map();
  constructor(init) {
    if (init instanceof _Headers) {
      init.forEach((v, k) => this.set(k, v));
    } else if (Array.isArray(init)) {
      for (const [k, v] of init) this.set(k, v);
    } else if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this.set(k, v);
    }
  }
  get(k) { return this.#map.get(k.toLowerCase()) ?? null; }
  set(k, v) { this.#map.set(k.toLowerCase(), String(v)); }
  append(k, v) {
    const lk = k.toLowerCase();
    const existing = this.#map.get(lk);
    this.#map.set(lk, existing != null ? `${existing}, ${String(v)}` : String(v));
  }
  has(k) { return this.#map.has(k.toLowerCase()); }
  delete(k) { return this.#map.delete(k.toLowerCase()); }
  forEach(cb) { this.#map.forEach((v, k) => cb(v, k, this)); }
  *entries() { yield* this.#map.entries(); }
  *keys() { yield* this.#map.keys(); }
  *values() { yield* this.#map.values(); }
  [Symbol.iterator]() { return this.entries(); }
}

class _Response {
  #body; #bodyUsed = false; #status; #statusText; #headers; #url; #webStream;
  constructor(body, { status = 200, statusText = '', headers = {}, url = '' } = {}) {
    this.#body = body;
    this.#status = status;
    this.#statusText = statusText;
    this.#headers = new _Headers(headers);
    this.#url = url;
    this.#webStream = undefined; // lazy-init, cached
  }
  get ok() { return this.#status >= 200 && this.#status < 300; }
  get status() { return this.#status; }
  get statusText() { return this.#statusText; }
  get headers() { return this.#headers; }
  get url() { return this.#url; }
  get bodyUsed() { return this.#bodyUsed; }
  get body() {
    if (this.#webStream !== undefined) return this.#webStream;
    if (this.#body instanceof Readable) {
      if (typeof Readable.toWeb === 'function') {
        this.#webStream = Readable.toWeb(this.#body);
      } else {
        const nodeStream = this.#body;
        this.#webStream = new ReadableStream({
          start(controller) {
            nodeStream.on('data', (chunk) => controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
            nodeStream.on('end', () => controller.close());
            nodeStream.on('error', (err) => controller.error(err));
          },
          cancel() { nodeStream.destroy(); },
        });
      }
      return this.#webStream;
    }
    this.#webStream = null;
    return null;
  }
  async text() {
    this.#bodyUsed = true;
    if (this.#body instanceof Readable) {
      const chunks = [];
      for await (const chunk of this.#body) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf-8');
    }
    if (Buffer.isBuffer(this.#body)) return this.#body.toString('utf-8');
    return String(this.#body ?? '');
  }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() {
    this.#bodyUsed = true;
    if (this.#body instanceof Readable) {
      const chunks = [];
      for await (const chunk of this.#body) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (Buffer.isBuffer(this.#body)) {
      return this.#body.buffer.slice(this.#body.byteOffset, this.#body.byteOffset + this.#body.byteLength);
    }
    const buf = Buffer.from(String(this.#body ?? ''), 'utf-8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  async blob() {
    const ab = await this.arrayBuffer();
    const { Blob: B } = await import('node:buffer');
    return new B([ab], { type: this.#headers.get('content-type') || '' });
  }
}

function _nativeFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    const urlStr = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = (init.method || 'GET').toUpperCase();
    console.error(`[DEBUG fetch] ${method} ${urlStr.slice(0,150)} body=${init.body ? init.body.length || '?' : 'none'}`);
    const parsed = new URL(urlStr);
    const transport = parsed.protocol === 'https:' ? _https : _http;
    const headers = {};

    if (init.headers) {
      if (init.headers instanceof _Headers || (init.headers.forEach && init.headers.entries)) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
      }
    }

    let bodyData = null;
    if (init.body != null) {
      if (typeof init.body === 'string') {
        bodyData = Buffer.from(init.body, 'utf-8');
      } else if (Buffer.isBuffer(init.body)) {
        bodyData = init.body;
      } else if (init.body instanceof Uint8Array) {
        bodyData = Buffer.from(init.body);
      } else {
        bodyData = Buffer.from(String(init.body), 'utf-8');
      }
      if (!headers['content-length']) {
        headers['content-length'] = String(bodyData.length);
      }
    }

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = transport.request(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr);
        const redirectInit = { ...init };
        if (res.statusCode === 303) {
          redirectInit.method = 'GET';
          delete redirectInit.body;
        }
        res.resume();
        _nativeFetch(redirectUrl.href, redirectInit).then(resolve, reject);
        return;
      }

      const responseHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v != null) responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }

      const response = new _Response(res, {
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: responseHeaders,
        url: urlStr,
      });
      console.error(`[DEBUG fetch] ${method} ${urlStr.slice(0,80)} → ${res.statusCode} ${res.statusMessage || ''}`);
      resolve(response);
    });

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        req.destroy();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => init.signal.removeEventListener('abort', onAbort));
    }

    req.on('error', (err) => {
      console.error(`[DEBUG fetch] ERROR ${method} ${urlStr.slice(0,80)}: ${err.message}`);
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); console.error(`[DEBUG fetch] TIMEOUT ${method} ${urlStr.slice(0,80)}`); reject(new Error('Request timed out')); });

    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// DOMException may not exist in Node.js v18
if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMException extends Error {
    #name;
    constructor(message, name = 'Error') { super(message); this.#name = name; }
    get name() { return this.#name; }
  };
}

// Replace the broken undici-based fetch with our native implementation.
// In Node.js v18, globalThis.fetch may be a lazy getter that triggers undici
// loading on first access. Use delete + defineProperty to fully replace it.
try { delete globalThis.fetch; } catch {}
Object.defineProperty(globalThis, 'fetch', {
  value: _nativeFetch, writable: true, configurable: true, enumerable: true,
});
try { delete globalThis.Headers; } catch {}
Object.defineProperty(globalThis, 'Headers', {
  value: _Headers, writable: true, configurable: true, enumerable: true,
});
try { delete globalThis.Response; } catch {}
Object.defineProperty(globalThis, 'Response', {
  value: _Response, writable: true, configurable: true, enumerable: true,
});
if (!globalThis.Request) {
  globalThis.Request = class Request {
    constructor(input, init = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.method = init.method || 'GET';
      this.headers = new _Headers(init.headers);
      this.body = init.body ?? null;
    }
  };
}

console.log('[fetch-polyfill] Replaced built-in fetch with native https implementation');
