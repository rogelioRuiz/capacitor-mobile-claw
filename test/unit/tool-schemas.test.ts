import { describe, expect, it } from 'vitest'
import { TOOL_SCHEMAS } from '../../src/agent/tool-schemas'

describe('TOOL_SCHEMAS', () => {
  it('should export exactly 14 tool schemas', () => {
    expect(TOOL_SCHEMAS).toHaveLength(14)
  })

  it('should have unique tool names', () => {
    const names = TOOL_SCHEMAS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  const expectedTools = [
    'read_file',
    'write_file',
    'list_files',
    'grep_files',
    'find_files',
    'edit_file',
    'execute_js',
    'execute_python',
    'git_init',
    'git_status',
    'git_add',
    'git_commit',
    'git_log',
    'git_diff',
  ]

  it('should contain all expected tool names', () => {
    const names = TOOL_SCHEMAS.map((s) => s.name)
    for (const expected of expectedTools) {
      expect(names).toContain(expected)
    }
  })

  it('should have required fields on every schema', () => {
    for (const schema of TOOL_SCHEMAS) {
      expect(schema.name).toBeDefined()
      expect(schema.label).toBeDefined()
      expect(schema.description).toBeDefined()
      expect(schema.parameters).toBeDefined()
      expect(typeof schema.name).toBe('string')
      expect(typeof schema.label).toBe('string')
      expect(typeof schema.description).toBe('string')
      expect(schema.name.length).toBeGreaterThan(0)
      expect(schema.label.length).toBeGreaterThan(0)
      expect(schema.description.length).toBeGreaterThan(0)
    }
  })

  it('should have Typebox Object schemas for parameters', () => {
    for (const schema of TOOL_SCHEMAS) {
      // Typebox Type.Object produces a schema with type: 'object' and properties
      expect(schema.parameters.type).toBe('object')
      expect(schema.parameters).toHaveProperty('properties')
    }
  })

  describe('specific tool schemas', () => {
    it('read_file requires path parameter', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.name === 'read_file')!
      expect(schema.parameters.properties).toHaveProperty('path')
      expect(schema.parameters.required).toContain('path')
    })

    it('write_file requires path and content parameters', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.name === 'write_file')!
      expect(schema.parameters.properties).toHaveProperty('path')
      expect(schema.parameters.properties).toHaveProperty('content')
      expect(schema.parameters.required).toContain('path')
      expect(schema.parameters.required).toContain('content')
    })

    it('edit_file requires path, old_text, and new_text', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.name === 'edit_file')!
      expect(schema.parameters.properties).toHaveProperty('path')
      expect(schema.parameters.properties).toHaveProperty('old_text')
      expect(schema.parameters.properties).toHaveProperty('new_text')
      expect(schema.parameters.required).toContain('path')
    })

    it('git_status has no required parameters', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.name === 'git_status')!
      const required = schema.parameters.required || []
      expect(required).toHaveLength(0)
    })

    it('list_files has optional path parameter', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.name === 'list_files')!
      expect(schema.parameters.properties).toHaveProperty('path')
      // path should NOT be required (it's Optional)
      const required = schema.parameters.required || []
      expect(required).not.toContain('path')
    })
  })
})
