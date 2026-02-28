/**
 * Tool schema definitions shared between WebView agent runner and Node.js worker.
 *
 * These are the Typebox schemas for all 14 built-in tools. The execute() functions
 * live in the worker (main.js) — only the schemas are needed in the WebView
 * for the tool proxy to register them with the Agent.
 */

import { Type } from '@sinclair/typebox'

export interface ToolSchema {
  name: string
  label: string
  description: string
  parameters: ReturnType<typeof Type.Object>
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file in the workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path from workspace root' }),
    }),
  },
  {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file in the workspace. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path from workspace root' }),
      content: Type.String({ description: 'File content to write' }),
    }),
  },
  {
    name: 'list_files',
    label: 'List Files',
    description: 'List files and directories in a workspace directory.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Relative path from workspace root (default: ".")' })),
    }),
  },
  {
    name: 'grep_files',
    label: 'Grep Files',
    description: 'Search file contents by regex pattern. Returns matching lines with file paths and line numbers.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression pattern to search for' }),
      path: Type.Optional(
        Type.String({ description: 'Directory or file to search in (default: "." for entire workspace)' }),
      ),
      case_insensitive: Type.Optional(
        Type.Boolean({ description: 'If true, search is case-insensitive (default: false)' }),
      ),
    }),
  },
  {
    name: 'find_files',
    label: 'Find Files',
    description: 'Find files by name pattern (glob matching). Searches recursively from the given path.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern to match file names (e.g. "*.ts", "test-*")' }),
      path: Type.Optional(Type.String({ description: 'Directory to search in (default: "." for entire workspace)' })),
    }),
  },
  {
    name: 'edit_file',
    label: 'Edit File',
    description:
      'Apply a surgical edit to a file: find exact old_text and replace it with new_text. Only the first occurrence is replaced. Use read_file first to see the current content.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path from workspace root' }),
      old_text: Type.String({ description: 'Exact text to find (must match precisely including whitespace)' }),
      new_text: Type.String({ description: 'Replacement text' }),
    }),
  },
  {
    name: 'execute_js',
    label: 'Execute JS',
    description:
      'Execute JavaScript code in a sandboxed VM. Returns stdout (captured console.log output) and the result of the last expression. No access to require, process, fs, or network. 5-second timeout.',
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript code to execute' }),
    }),
  },
  {
    name: 'execute_python',
    label: 'Execute Python',
    description:
      'Execute Python code in a sandboxed Pyodide (WebAssembly) environment. Returns stdout (captured print output) and the result of the last expression. Includes math, json, re, collections, itertools, functools, datetime. No filesystem, network, or subprocess access. 5-second timeout.',
    parameters: Type.Object({
      code: Type.String({ description: 'Python code to execute' }),
    }),
  },
  {
    name: 'git_init',
    label: 'Git Init',
    description: 'Initialize a new git repository in the workspace. Auto-creates .gitignore.',
    parameters: Type.Object({
      default_branch: Type.Optional(Type.String({ description: 'Default branch name (default: "main")' })),
    }),
  },
  {
    name: 'git_status',
    label: 'Git Status',
    description: 'Show the working tree status: staged, unstaged, and untracked files.',
    parameters: Type.Object({}),
  },
  {
    name: 'git_add',
    label: 'Git Add',
    description: 'Stage files for commit. Use "." to stage all changes.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path or "." for all files' }),
    }),
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
  },
  {
    name: 'git_log',
    label: 'Git Log',
    description: 'Show the commit log. Returns the most recent N commits.',
    parameters: Type.Object({
      max_count: Type.Optional(Type.Number({ description: 'Maximum number of commits to return (default: 10)' })),
    }),
  },
  {
    name: 'git_diff',
    label: 'Git Diff',
    description:
      'Show diffs of file changes. Without arguments, shows unstaged changes. With cached=true, shows staged changes.',
    parameters: Type.Object({
      cached: Type.Optional(Type.Boolean({ description: 'If true, show staged changes instead of unstaged' })),
    }),
  },
]
