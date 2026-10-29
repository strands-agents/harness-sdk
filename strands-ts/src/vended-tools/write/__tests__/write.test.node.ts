/**
 * Tests for the sandbox-routed write tool.
 *
 * Exercises the tool against a real `NotASandboxLocalEnvironment` (host
 * filesystem) via `invoke`, which surfaces thrown errors directly. The
 * sandbox-execution tests assume POSIX path semantics and are skipped on
 * Windows; the pure path-validation tests run everywhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeWrite, write } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'
import type { Sandbox } from '../../../sandbox/base.js'

function toolContext(sandbox: Sandbox = new NotASandboxLocalEnvironment()): ToolContext {
  const agent = createMockAgent({ extra: { sandbox } })
  return {
    toolUse: { name: 'write', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

describe.skipIf(process.platform === 'win32')('write tool', () => {
  const writeTool = makeWrite(new NotASandboxLocalEnvironment())
  const ctx = toolContext()
  let tmpPath: string

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'write-tool-test-'))
  })

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true })
  })

  it('creates file', async () => {
    const filePath = join(tmpPath, 'new.txt')
    const result = await writeTool.invoke({ path: filePath, content: 'hello\nworld' }, ctx)
    expect(result).toBe(`Wrote 2 lines to ${filePath}.`)
    expect(readFileSync(filePath, 'utf-8')).toBe('hello\nworld')
  })

  it('overwrites existing file', async () => {
    const existing = join(tmpPath, 'f.txt')
    writeFileSync(existing, 'old content')
    const result = await writeTool.invoke({ path: existing, content: 'new' }, ctx)
    expect(result).toBe(`Wrote 1 line to ${existing}.`)
    expect(readFileSync(existing, 'utf-8')).toBe('new')
  })

  it('empty content reports zero lines', async () => {
    const filePath = join(tmpPath, 'empty.txt')
    const result = await writeTool.invoke({ path: filePath, content: '' }, ctx)
    expect(result).toBe(`Wrote 0 lines to ${filePath}.`)
    expect(readFileSync(filePath, 'utf-8')).toBe('')
  })

  it('single line without trailing newline', async () => {
    const filePath = join(tmpPath, 'one.txt')
    const result = await writeTool.invoke({ path: filePath, content: 'just one line' }, ctx)
    expect(result).toBe(`Wrote 1 line to ${filePath}.`)
  })

  it('trailing newline counts the empty tail', async () => {
    // `'a\nb\n'.split('\n')` is `['a', 'b', '']` — three entries for two
    // text lines plus the final newline. Matches the harness tool's count.
    const filePath = join(tmpPath, 'tail.txt')
    const result = await writeTool.invoke({ path: filePath, content: 'a\nb\n' }, ctx)
    expect(result).toBe(`Wrote 3 lines to ${filePath}.`)
  })

  it('creates parent directories', async () => {
    const nested = join(tmpPath, 'a', 'b', 'c.txt')
    await writeTool.invoke({ path: nested, content: 'deep' }, ctx)
    expect(readFileSync(nested, 'utf-8')).toBe('deep')
  })
})

describe('write tool path validation', () => {
  const ctx = toolContext()

  it('rejects relative path', async () => {
    await expect(write.invoke({ path: 'relative.txt', content: 'x' }, ctx)).rejects.toThrow('not absolute')
  })

  it('rejects parent traversal (posix)', async () => {
    await expect(write.invoke({ path: '/tmp/../etc/passwd', content: 'x' }, ctx)).rejects.toThrow(
      'path traversal is not allowed'
    )
  })

  it('rejects parent traversal (windows)', async () => {
    await expect(write.invoke({ path: 'C:\\project\\..\\etc\\hosts', content: 'x' }, ctx)).rejects.toThrow(
      'path traversal is not allowed'
    )
  })
})

describe.skipIf(process.platform === 'win32')('write tool sandbox binding', () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'write-tool-test-'))
  })

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true })
  })

  it('bound sandbox overrides agent sandbox', async () => {
    const boundTool = makeWrite(new NotASandboxLocalEnvironment())
    const agentSandbox = { writeText: vi.fn() }
    const filePath = join(tmpPath, 'f.txt')
    await boundTool.invoke({ path: filePath, content: 'from-bound' }, toolContext(agentSandbox as unknown as Sandbox))
    expect(readFileSync(filePath, 'utf-8')).toBe('from-bound')
    expect(agentSandbox.writeText).not.toHaveBeenCalled()
  })

  it('default write reads agent sandbox', async () => {
    const agentSandbox = { writeText: vi.fn() }
    const filePath = join(tmpPath, 'f.txt')
    await write.invoke({ path: filePath, content: 'from-agent' }, toolContext(agentSandbox as unknown as Sandbox))
    expect(agentSandbox.writeText).toHaveBeenCalledExactlyOnceWith(filePath, 'from-agent')
  })
})
