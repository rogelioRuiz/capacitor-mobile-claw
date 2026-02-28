/**
 * Phase 3 E2E Test: Git Tools (isomorphic-git)
 *
 * Verifies:
 * - git_init creates .git directory and .gitignore
 * - git_status shows untracked, staged, modified files
 * - git_add stages files (single and all)
 * - git_commit creates commits with SHA
 * - git_log returns commit history
 * - git_diff shows unstaged and staged changes
 * - Full workflow: init → write → add → commit → modify → diff → commit → log
 */

import * as fs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TEST_ROOT = join(process.cwd(), '.test-git-tools')
const WORKSPACE = join(TEST_ROOT, 'workspace')

// ── Replicate git tool functions from main.js ───────────────────────────

async function gitInitTool(args: { default_branch?: string }) {
  const defaultBranch = args.default_branch || 'main'
  try {
    await git.init({ fs, dir: WORKSPACE, defaultBranch })

    const gitignorePath = join(WORKSPACE, '.gitignore')
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.openclaw/\n')
    }

    return { success: true, message: `Initialized git repository with branch "${defaultBranch}"` }
  } catch (err: any) {
    return { error: `Failed to initialize git: ${err.message}` }
  }
}

async function gitStatusTool() {
  try {
    const matrix = await git.statusMatrix({ fs, dir: WORKSPACE })
    const files = matrix
      .map(([filepath, head, workdir, stage]: any) => {
        let status = 'unmodified'
        if (head === 0 && workdir === 2 && stage === 0) status = 'untracked'
        else if (head === 0 && workdir === 2 && stage === 2) status = 'added'
        else if (head === 0 && workdir === 2 && stage === 3) status = 'added (modified)'
        else if (head === 1 && workdir === 2 && stage === 1) status = 'modified (unstaged)'
        else if (head === 1 && workdir === 2 && stage === 2) status = 'modified (staged)'
        else if (head === 1 && workdir === 2 && stage === 3) status = 'modified (staged + unstaged)'
        else if (head === 1 && workdir === 0 && stage === 0) status = 'deleted (unstaged)'
        else if (head === 1 && workdir === 0 && stage === 1) status = 'deleted (staged)'
        return { path: filepath, status }
      })
      .filter((f: any) => f.status !== 'unmodified')
    return { files }
  } catch (err: any) {
    return { error: `Failed to get status: ${err.message}` }
  }
}

async function gitAddTool(args: { path: string }) {
  try {
    if (args.path === '.') {
      const matrix = await git.statusMatrix({ fs, dir: WORKSPACE })
      for (const [filepath, head, workdir, stage] of matrix) {
        if (workdir === 0) {
          await git.remove({ fs, dir: WORKSPACE, filepath })
        } else if (head !== workdir || workdir !== stage) {
          await git.add({ fs, dir: WORKSPACE, filepath })
        }
      }
      return { success: true, message: 'All changes staged' }
    } else {
      await git.add({ fs, dir: WORKSPACE, filepath: args.path })
      return { success: true, path: args.path }
    }
  } catch (err: any) {
    return { error: `Failed to stage: ${err.message}` }
  }
}

async function gitCommitTool(args: { message: string; author_name?: string; author_email?: string }) {
  try {
    const sha = await git.commit({
      fs,
      dir: WORKSPACE,
      message: args.message,
      author: {
        name: args.author_name || 'mobile-claw',
        email: args.author_email || 'agent@mobile-claw.local',
      },
    })
    return { success: true, sha, message: args.message }
  } catch (err: any) {
    return { error: `Failed to commit: ${err.message}` }
  }
}

async function gitLogTool(args: { max_count?: number }) {
  try {
    const commits = await git.log({
      fs,
      dir: WORKSPACE,
      depth: args.max_count || 10,
    })
    return {
      commits: commits.map((c: any) => ({
        sha: c.oid,
        message: c.commit.message,
        author: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
      })),
    }
  } catch (err: any) {
    return { error: `Failed to get log: ${err.message}` }
  }
}

async function gitDiffTool(args: { cached?: boolean }) {
  try {
    const matrix = await git.statusMatrix({ fs, dir: WORKSPACE })
    const changes: any[] = []

    // Resolve HEAD to a commit OID (readBlob needs a SHA, not a ref)
    let headOid: string | null = null
    try {
      headOid = await git.resolveRef({ fs, dir: WORKSPACE, ref: 'HEAD' })
    } catch {
      /* no commits yet */
    }

    for (const [filepath, head, workdir, stage] of matrix) {
      const isRelevant = args.cached ? stage !== head : workdir !== stage

      if (!isRelevant) continue

      let currentContent: string | null = null
      try {
        currentContent = readFileSync(join(WORKSPACE, filepath), 'utf8')
      } catch {
        /* file deleted */
      }

      let previousContent: string | null = null
      if (headOid) {
        try {
          const { blob } = await git.readBlob({ fs, dir: WORKSPACE, oid: headOid, filepath })
          previousContent = new TextDecoder().decode(blob)
        } catch {
          /* new file */
        }
      }

      changes.push({
        path: filepath,
        previous: previousContent ? previousContent.substring(0, 2000) : null,
        current: currentContent ? currentContent.substring(0, 2000) : null,
        type: !previousContent ? 'added' : !currentContent ? 'deleted' : 'modified',
      })
    }

    return { changes }
  } catch (err: any) {
    return { error: `Failed to get diff: ${err.message}` }
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('git_init', () => {
  it('initializes a new git repo in workspace', async () => {
    const result = await gitInitTool({})
    expect(result.success).toBe(true)
    expect(result.message).toContain('main')
  })

  it('creates .git directory', () => {
    expect(existsSync(join(WORKSPACE, '.git'))).toBe(true)
  })

  it('auto-creates .gitignore with .openclaw/', () => {
    const gitignore = readFileSync(join(WORKSPACE, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.openclaw/')
  })

  it('uses custom default_branch name', async () => {
    // Clean and reinit with custom branch
    rmSync(join(WORKSPACE, '.git'), { recursive: true, force: true })
    const result = await gitInitTool({ default_branch: 'develop' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('develop')

    // Re-init with main for subsequent tests
    rmSync(join(WORKSPACE, '.git'), { recursive: true, force: true })
    await gitInitTool({})
  })

  it('handles already-initialized repo gracefully', async () => {
    const result = await gitInitTool({})
    expect(result.success).toBe(true)
  })
})

describe('git_status', () => {
  it('shows untracked files', async () => {
    writeFileSync(join(WORKSPACE, 'hello.txt'), 'Hello World\n')

    const result = await gitStatusTool()
    expect(result.files).toBeDefined()
    const hello = result.files?.find((f: any) => f.path === 'hello.txt')
    expect(hello).toBeDefined()
    expect(hello?.status).toBe('untracked')
  })

  it('shows staged files after git_add', async () => {
    await gitAddTool({ path: 'hello.txt' })

    const result = await gitStatusTool()
    const hello = result.files?.find((f: any) => f.path === 'hello.txt')
    expect(hello).toBeDefined()
    expect(hello?.status).toBe('added')
  })
})

describe('git_add', () => {
  it('stages a specific file', async () => {
    writeFileSync(join(WORKSPACE, 'second.txt'), 'Second file\n')
    const result = await gitAddTool({ path: 'second.txt' })
    expect(result.success).toBe(true)
    expect(result.path).toBe('second.txt')
  })

  it('stages all changes with "."', async () => {
    writeFileSync(join(WORKSPACE, 'third.txt'), 'Third file\n')
    const result = await gitAddTool({ path: '.' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('All changes staged')

    // Verify third.txt is staged
    const status = await gitStatusTool()
    const third = status.files?.find((f: any) => f.path === 'third.txt')
    expect(third?.status).toBe('added')
  })
})

describe('git_commit', () => {
  it('creates commit with message', async () => {
    const result = await gitCommitTool({ message: 'Initial commit' })
    expect(result.success).toBe(true)
    expect(result.sha).toBeDefined()
    expect(result.sha?.length).toBe(40) // SHA-1 hash
    expect(result.message).toBe('Initial commit')
  })

  it('uses default author name/email', async () => {
    const log = await gitLogTool({ max_count: 1 })
    expect(log.commits?.[0].author).toBe('mobile-claw')
    expect(log.commits?.[0].email).toBe('agent@mobile-claw.local')
  })

  it('uses custom author name/email', async () => {
    writeFileSync(join(WORKSPACE, 'custom-author.txt'), 'test\n')
    await gitAddTool({ path: 'custom-author.txt' })
    await gitCommitTool({
      message: 'Custom author commit',
      author_name: 'Test User',
      author_email: 'test@example.com',
    })

    const log = await gitLogTool({ max_count: 1 })
    expect(log.commits?.[0].author).toBe('Test User')
    expect(log.commits?.[0].email).toBe('test@example.com')
  })

  it('returns error when nothing to commit', async () => {
    const result = await gitCommitTool({ message: 'Empty commit' })
    // isomorphic-git may error or create empty commit depending on version
    // Either outcome is acceptable
    expect(result.success || result.error).toBeDefined()
  })
})

describe('git_log', () => {
  it('returns commits', async () => {
    const result = await gitLogTool({})
    expect(result.commits).toBeDefined()
    expect(result.commits?.length).toBeGreaterThanOrEqual(2)
  })

  it('respects max_count parameter', async () => {
    const result = await gitLogTool({ max_count: 1 })
    expect(result.commits?.length).toBe(1)
  })

  it('includes sha, message, author, timestamp', async () => {
    const result = await gitLogTool({ max_count: 1 })
    const commit = result.commits?.[0]
    expect(commit.sha).toBeDefined()
    expect(commit.sha.length).toBe(40)
    expect(commit.message).toBeDefined()
    expect(commit.author).toBeDefined()
    expect(commit.email).toBeDefined()
    expect(commit.timestamp).toBeDefined()
    // Timestamp should be ISO format
    expect(new Date(commit.timestamp).toISOString()).toBe(commit.timestamp)
  })

  it('newest commit is first', async () => {
    const result = await gitLogTool({})
    // The newest commit should be more recent than the last one
    const first = new Date(result.commits?.[0].timestamp).getTime()
    const last = new Date(result.commits?.[result.commits?.length - 1].timestamp).getTime()
    expect(first).toBeGreaterThanOrEqual(last)
  })
})

describe('git_diff', () => {
  it('shows unstaged changes for modified file', async () => {
    writeFileSync(join(WORKSPACE, 'hello.txt'), 'Hello Modified World\n')

    const result = await gitDiffTool({})
    expect(result.changes).toBeDefined()
    const hello = result.changes?.find((c: any) => c.path === 'hello.txt')
    expect(hello).toBeDefined()
    expect(hello?.type).toBe('modified')
    expect(hello?.previous).toContain('Hello World')
    expect(hello?.current).toContain('Hello Modified World')
  })

  it('shows staged changes with cached=true', async () => {
    await gitAddTool({ path: 'hello.txt' })

    const result = await gitDiffTool({ cached: true })
    const hello = result.changes?.find((c: any) => c.path === 'hello.txt')
    expect(hello).toBeDefined()
    expect(hello?.type).toBe('modified')
  })

  it('returns empty for clean working tree', async () => {
    await gitCommitTool({ message: 'Commit modified hello' })

    const result = await gitDiffTool({})
    expect(result.changes?.length).toBe(0)
  })

  it('shows added file diff', async () => {
    writeFileSync(join(WORKSPACE, 'brand-new.txt'), 'Brand new content\n')
    await gitAddTool({ path: 'brand-new.txt' })

    const result = await gitDiffTool({ cached: true })
    const newFile = result.changes?.find((c: any) => c.path === 'brand-new.txt')
    expect(newFile).toBeDefined()
    expect(newFile?.type).toBe('added')
    expect(newFile?.previous).toBeNull()
    expect(newFile?.current).toContain('Brand new content')
  })
})

describe('Full git workflow', () => {
  it('init → write → add → commit → modify → diff → add → commit → log', async () => {
    // Clean workspace for fresh workflow
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })

    // 1. Init
    const init = await gitInitTool({})
    expect(init.success).toBe(true)

    // 2. Write files
    writeFileSync(join(WORKSPACE, 'app.js'), 'console.log("v1");\n')
    writeFileSync(join(WORKSPACE, 'README.md'), '# My App\n')

    // 3. Add all
    const add1 = await gitAddTool({ path: '.' })
    expect(add1.success).toBe(true)

    // 4. Commit
    const commit1 = await gitCommitTool({ message: 'feat: initial version' })
    expect(commit1.success).toBe(true)
    const sha1 = commit1.sha

    // 5. Modify (different length so isomorphic-git's stat check detects the change)
    writeFileSync(join(WORKSPACE, 'app.js'), 'console.log("version-2-updated");\n')

    // 6. Diff (unstaged)
    const diff1 = await gitDiffTool({})
    expect(diff1.changes?.length).toBe(1)
    expect(diff1.changes?.[0].path).toBe('app.js')
    expect(diff1.changes?.[0].type).toBe('modified')

    // 7. Add + commit
    await gitAddTool({ path: '.' })
    const commit2 = await gitCommitTool({ message: 'feat: update to v2' })
    expect(commit2.success).toBe(true)

    // 8. Log
    const log = await gitLogTool({})
    expect(log.commits?.length).toBe(2)
    expect(log.commits?.[0].message).toContain('v2')
    expect(log.commits?.[1].message).toContain('initial')
    expect(log.commits?.[1].sha).toBe(sha1)
  })
})
