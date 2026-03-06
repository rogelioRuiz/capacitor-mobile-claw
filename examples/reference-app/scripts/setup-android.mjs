#!/usr/bin/env node
/**
 * setup-android.mjs — One-shot Android platform setup.
 *
 * Runs `npx cap add android` (if android/ doesn't exist) then applies 3 idempotent patches:
 *   A. Root build.gradle — Kotlin Gradle plugin (required by capacitor-lancedb)
 *   B. App build.gradle  — Java 21 compileOptions
 *   C. AndroidManifest   — OAuth deep-link intent filter
 *
 * Safe to run multiple times — each patch checks before applying.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error(
    '[setup-android] ERROR: ANDROID_HOME is not set.\n\n' +
      '  export ANDROID_HOME=$HOME/Android/Sdk        # Linux\n' +
      '  export ANDROID_HOME=$HOME/Library/Android/sdk  # macOS\n',
  )
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ANDROID = join(ROOT, 'android')

// ── Step 0: cap add android (if needed) ─────────────────────────────────────

if (!existsSync(ANDROID)) {
  console.log('[setup-android] android/ not found — running cap add android...')
  execSync('npx cap add android', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[setup-android] android/ already exists — skipping cap add')
}

let patchCount = 0

// ── Patch A: Root build.gradle — Kotlin Gradle plugin ───────────────────────

const rootGradle = join(ANDROID, 'build.gradle')
const rootSrc = readFileSync(rootGradle, 'utf8')

if (rootSrc.includes('kotlin-gradle-plugin')) {
  console.log('[setup-android] Patch A: Kotlin plugin already present — skipping')
} else {
  const patched = rootSrc.replace(
    "classpath 'com.google.gms:google-services:4.4.4'",
    "classpath 'com.google.gms:google-services:4.4.4'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20'"
  )
  if (patched === rootSrc) {
    console.error('[setup-android] Patch A: Could not find google-services classpath line — skipping')
  } else {
    writeFileSync(rootGradle, patched)
    console.log('[setup-android] Patch A: Added Kotlin Gradle plugin classpath')
    patchCount++
  }
}

// ── Patch B: App build.gradle — Java 21 compileOptions ──────────────────────

const appGradle = join(ANDROID, 'app', 'build.gradle')
const appSrc = readFileSync(appGradle, 'utf8')

if (appSrc.includes('JavaVersion.VERSION_21')) {
  console.log('[setup-android] Patch B: Java 21 compileOptions already present — skipping')
} else {
  const patched = appSrc.replace(
    /(\n\s+buildTypes\s*\{)/,
    `\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_21\n        targetCompatibility JavaVersion.VERSION_21\n    }\n$1`
  )

  if (patched === appSrc) {
    console.error('[setup-android] Patch B: Could not find buildTypes block — skipping')
  } else {
    writeFileSync(appGradle, patched)
    console.log('[setup-android] Patch B: Added Java 21 compileOptions')
    patchCount++
  }
}

// ── Patch C: AndroidManifest.xml — OAuth deep-link ──────────────────────────

const manifestPath = join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
const manifestSrc = readFileSync(manifestPath, 'utf8')

if (manifestSrc.includes('io.mobileclaw.reference')) {
  console.log('[setup-android] Patch C: OAuth deep-link already present — skipping')
} else {
  const intentFilter = `
            <!-- Deep-link intent filter for OAuth callbacks (OpenRouter etc.) -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="io.mobileclaw.reference" />
            </intent-filter>
`
  // Insert after the LAUNCHER intent-filter closing tag
  const patched = manifestSrc.replace(
    /(<\/intent-filter>)\s*(\n\s*<\/activity>)/,
    `$1\n${intentFilter}\n        </activity>`
  )

  if (patched === manifestSrc) {
    console.error('[setup-android] Patch C: Could not find activity closing tag — skipping')
  } else {
    writeFileSync(manifestPath, patched)
    console.log('[setup-android] Patch C: Added OAuth deep-link intent filter')
    patchCount++
  }
}

// ── Done ────────────────────────────────────────────────────────────────────

if (patchCount > 0) {
  console.log(`[setup-android] Applied ${patchCount} patch(es)`)
} else {
  console.log('[setup-android] No patches needed — project is already configured')
}

// Build web assets if dist/ doesn't exist
const DIST = join(ROOT, 'dist')
if (!existsSync(DIST)) {
  console.log('[setup-android] dist/ not found — building web assets...')
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('[setup-android] dist/ already exists — skipping build')
}

// Run cap sync to copy web assets
console.log('[setup-android] Running cap sync android...')
execSync('npx cap sync android', { cwd: ROOT, stdio: 'inherit' })

// Verify cordova-plugins build.gradle isn't truncated (cap sync can produce truncated files)
const cordovaGradle = join(ANDROID, 'capacitor-cordova-android-plugins', 'build.gradle')
if (existsSync(cordovaGradle)) {
  const content = readFileSync(cordovaGradle, 'utf8')
  if (!content.trimEnd().endsWith('}')) {
    console.log('[setup-android] Detected truncated cordova-plugins build.gradle — re-syncing...')
    const { unlinkSync } = await import('fs')
    unlinkSync(cordovaGradle)
    execSync('npx cap sync android', { cwd: ROOT, stdio: 'inherit' })
    const fixed = readFileSync(cordovaGradle, 'utf8')
    if (fixed.trimEnd().endsWith('}')) {
      console.log('[setup-android] Fixed truncated build.gradle')
    } else {
      console.error('[setup-android] WARNING: cordova-plugins build.gradle may still be truncated')
    }
  }
}

console.log('[setup-android] Done! Build with: npm run build:android')
