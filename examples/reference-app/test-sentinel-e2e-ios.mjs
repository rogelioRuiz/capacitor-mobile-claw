#!/usr/bin/env node
/**
 * Sentinel E2E Test Suite — iOS Simulator Runner
 *
 * HTTP server approach: The app detects the server and runs tests in-process,
 * POSTing results back. This script handles build, install, launch, and
 * result collection.
 *
 * Usage (from reference-app dir on the Mac build machine):
 *   node test-sentinel-e2e-ios.mjs
 *
 * Prerequisites:
 *   - iOS Simulator booted (xcrun simctl boot "iPhone 16e")
 *   - Reference app built: npm run cap:build (or this script builds it)
 *   - Node.js 20+
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ──────────────────────────────────────────────────────────────────
const BUNDLE_ID = 'io.mobileclaw.reference'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 100 // 57 sentinel + 1 credential injection + ~42 memory/lancedb
const TIMEOUT_MS = 300_000 // 5 minutes (heartbeat wakes need Claude API calls)

// Load OAuth credentials from env or JSON file
// Set ANTHROPIC_OAUTH_FILE to a JSON file with { access, refresh, expiresAt } fields
// Or set ANTHROPIC_ACCESS_TOKEN directly
function loadCredentials() {
  if (process.env.ANTHROPIC_ACCESS_TOKEN) {
    return {
      accessToken: process.env.ANTHROPIC_ACCESS_TOKEN,
      refreshToken: process.env.ANTHROPIC_REFRESH_TOKEN || '',
      expiresAt: parseInt(process.env.ANTHROPIC_EXPIRES_AT || '0') || Date.now() + 3600000,
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY }
  }
  const credsFile = process.env.ANTHROPIC_OAUTH_FILE || path.join(__dirname, '.sentinel-creds.json')
  try {
    const data = JSON.parse(readFileSync(credsFile, 'utf8'))
    if (data.access) return { accessToken: data.access, refreshToken: data.refresh || '', expiresAt: data.expiresAt || Date.now() + 3600000 }
    if (data.accessToken) return data
    if (data.apiKey) return data
  } catch {}
  return null
}
const sentinelCreds = loadCredentials()

// ─── Test runner state ───────────────────────────────────────────────────────
let passedTests = 0
let failedTests = 0
const testResults = []

function logSection(title) {
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`)
}
function pass(name, detail) {
  passedTests++
  testResults.push({ name, status: 'PASS' })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, error) {
  failedTests++
  testResults.push({ name, status: 'FAIL', error })
  console.log(`  ❌ ${name} — ${error}`)
}

// ─── simctl helpers ──────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, {
    encoding: 'utf8',
    timeout: 30000,
    ...opts,
  }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === 'Booted') return d.udid
    }
  }
  return null
}

function terminateApp(udid) {
  try {
    simctl(`terminate ${udid} ${BUNDLE_ID}`)
  } catch {}
}

function launchApp(udid) {
  try {
    simctl(`terminate ${udid} ${BUNDLE_ID}`)
  } catch {}
  execSync('sleep 0.5', { shell: true })
  simctl(`launch ${udid} ${BUNDLE_ID}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── HTTP result server ──────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const results = new Map()
    let done = false
    let doneResolve, doneReject
    const donePromise = new Promise((res, rej) => {
      doneResolve = res
      doneReject = rej
    })

    const timer = setTimeout(() => {
      if (!done)
        doneReject(
          new Error(
            `Timeout after ${TIMEOUT_MS / 1000}s — only ${results.size} results received`,
          ),
        )
    }, TIMEOUT_MS)

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${RUNNER_PORT}`)

      // CORS for simulator WebView
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      // Test mode detection ping
      if (req.method === 'GET' && url.pathname === '/__sentinel_ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // Serve OAuth/API credentials for heartbeat tests
      if (req.method === 'GET' && url.pathname === '/__sentinel_creds') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(sentinelCreds || {}))
        return
      }

      // Collect a single test result
      if (req.method === 'POST' && url.pathname === '/__sentinel_result') {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          try {
            const r = JSON.parse(body)
            results.set(r.name, r)
            const status = r.status === 'pass' ? '  ✅' : '  ❌'
            const err = r.error ? ` — ${r.error}` : ''
            console.log(`${status} ${r.name}${err}`)
          } catch {}
          res.writeHead(200)
          res.end()
        })
        return
      }

      // All tests done
      if (req.method === 'POST' && url.pathname === '/__sentinel_done') {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          let summary = {}
          try {
            summary = JSON.parse(body)
          } catch {}
          clearTimeout(timer)
          done = true
          doneResolve({ results, summary })
          res.writeHead(200)
          res.end()
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.listen(RUNNER_PORT, '0.0.0.0', () => {
      console.log(`  → HTTP server listening on :${RUNNER_PORT}`)
      resolve({ server, donePromise })
    })
    server.on('error', reject)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════╗')
  console.log('║  Sentinel iOS E2E Test Suite         ║')
  console.log('╚══════════════════════════════════════╝')

  // ─── 1. Simulator Setup ────────────────────────────────────────────────
  logSection('1 — Simulator Setup')

  let udid
  try {
    udid = getBootedUDID()
    if (!udid)
      throw new Error('No booted simulator found. Boot one with: xcrun simctl boot "iPhone 16e"')
    pass('Booted simulator found', `UDID ${udid}`)
  } catch (err) {
    fail('Booted simulator found', err.message)
    process.exit(1)
  }

  // ─── 2. Start HTTP server (BEFORE app launch) ─────────────────────────
  let server, donePromise
  try {
    ;({ server, donePromise } = await startServer())
    // Ensure server is closed on exit/SIGINT to prevent EADDRINUSE on re-run
    const cleanup = () => { try { server.close() } catch {} }
    process.on('SIGINT', () => { cleanup(); process.exit(130) })
    process.on('SIGTERM', () => { cleanup(); process.exit(143) })
    process.on('exit', cleanup)
    pass('HTTP result server started', `port ${RUNNER_PORT}`)
  } catch (err) {
    fail('HTTP result server started', err.message)
    process.exit(1)
  }

  // ─── 3. Build + install + launch ──────────────────────────────────────
  try {
    const iosDir = path.join(__dirname, 'ios/App')

    // Touch marker before build
    execSync('touch /tmp/.sentinel-build-marker', { shell: true })
    console.log('  → Building with xcodebuild...')
    execSync(
      `xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator ` +
        `-destination "platform=iOS Simulator,id=${udid}" -configuration Debug build ` +
        `CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`,
      {
        cwd: iosDir,
        encoding: 'utf8',
        timeout: 300000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    console.log('  → Installing app...')
    const appPath = execSync(
      `find ~/Library/Developer/Xcode/DerivedData -name "App.app" ` +
        `-newer /tmp/.sentinel-build-marker ` +
        `-path "*/Debug-iphonesimulator/*" -not -path "*PlugIns*" 2>/dev/null | head -1`,
      { encoding: 'utf8', shell: true },
    ).trim()
    if (!appPath) throw new Error('App.app not found in DerivedData')

    // Uninstall first to clear app container data between runs
    try {
      simctl(`uninstall ${udid} ${BUNDLE_ID}`)
    } catch {}
    simctl(`install ${udid} "${appPath}"`)

    console.log('  → Launching app...')
    launchApp(udid)
    pass('App built, installed, and launched')
  } catch (err) {
    const lines = (err.stderr || err.stdout || err.message || '').split('\n')
    const errLine =
      lines
        .filter((l) => l.includes('error:'))
        .slice(0, 3)
        .join(' | ') || lines[0]
    fail('App built, installed, and launched', errLine.slice(0, 200))
    server.close()
    process.exit(1)
  }

  // ─── 4. Wait for app-driven tests ────────────────────────────────────
  logSection('2 — App-Driven Tests (57 tests)')
  console.log('  → Waiting for app to run all tests and POST results...\n')

  let captureResult
  try {
    captureResult = await donePromise
  } catch (err) {
    fail('App test suite completed', err.message)
    server.close()
    process.exit(1)
  }

  // ─── 5. Summary ──────────────────────────────────────────────────────
  server.close()

  const appPassed = captureResult.summary?.passed ?? 0
  const appFailed = captureResult.summary?.failed ?? 0
  const appTotal = captureResult.summary?.total ?? captureResult.results.size
  // Add runner-level tests (simulator, server, build)
  const totalPassed = passedTests + appPassed
  const totalFailed = failedTests + appFailed
  const total = totalPassed + totalFailed

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Results: ${totalPassed}/${total} passed, ${totalFailed} failed`)
  console.log(`  App reported: ${appPassed}/${appTotal} passed`)
  if (totalFailed > 0) {
    console.log('\n  Failed tests:')
    // Runner-level failures
    testResults
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`    ❌ ${r.name}${r.error ? ` — ${r.error}` : ''}`)
      })
    // App-level failures
    for (const [name, r] of captureResult.results) {
      if (r.status === 'fail') {
        console.log(`    ❌ ${name}${r.error ? ` — ${r.error}` : ''}`)
      }
    }
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)

  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\n  Fatal error:', err.message)
  process.exit(1)
})
