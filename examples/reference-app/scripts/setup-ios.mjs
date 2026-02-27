#!/usr/bin/env node
/**
 * setup-ios.mjs — One-shot iOS platform setup.
 *
 * Runs `npx cap add ios` (if ios/ doesn't exist) then syncs web assets.
 * The SQLite SPM patch runs automatically on `npm install` (postinstall),
 * so SPM resolution picks up the already-patched node_modules.
 *
 * Safe to run multiple times.
 */

import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const IOS = join(ROOT, 'ios')

// ── Step 0: cap add ios (if needed) ─────────────────────────────────────────

if (!existsSync(IOS)) {
  console.log('[setup-ios] ios/ not found — running cap add ios...')
  execSync('npx cap add ios', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[setup-ios] ios/ already exists — skipping cap add')
}

// ── Step 1: Build web assets (if dist/ doesn't exist) ────────────────────────

const DIST = join(ROOT, 'dist')
if (!existsSync(DIST)) {
  console.log('[setup-ios] dist/ not found — building web assets...')
  execSync('npm run setup:worker', { cwd: ROOT, stdio: 'inherit' })
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[setup-ios] dist/ already exists — skipping build')
}

// ── Step 2: cap sync ios ────────────────────────────────────────────────────

console.log('[setup-ios] Running cap sync ios...')
execSync('npx cap sync ios', { cwd: ROOT, stdio: 'inherit' })

console.log('[setup-ios] Done! Build with: npm run build:ios')
