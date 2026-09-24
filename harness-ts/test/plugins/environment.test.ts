import type { ExecutionResult, FileInfo, LocalAgent, Plugin, Sandbox } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import {
  EnvironmentContext,
  type EnvironmentMemo,
  renderEnvironment,
  AGENTS_MD_CAP,
} from '../../src/plugins/environment.js'

function plugins(agent: unknown): Plugin[] {
  const registry = (agent as { _pluginRegistry: { _plugins: Map<string, Plugin>; _pending?: Plugin[] } })
    ._pluginRegistry
  return [...registry._plugins.values(), ...(registry._pending ?? [])]
}

class FakeSandbox {
  listCalls = 0
  constructor(
    private files: Record<string, string>,
    private tree: Record<string, FileInfo[]>,
    private cwd: string | null = '/work'
  ) {}

  async readText(path: string): Promise<string> {
    const content = this.files[path]
    if (content === undefined) {
      throw new Error(`not found: ${path}`)
    }
    return content
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    this.listCalls++
    const entries = this.tree[path]
    if (entries === undefined) {
      throw new Error(`not found: ${path}`)
    }
    return entries
  }

  async execute(command: string): Promise<ExecutionResult> {
    if (this.cwd === null) {
      throw new Error('no shell')
    }
    const out = command.startsWith('uname') ? 'Linux' : this.cwd
    return { type: 'executionResult', exitCode: 0, stdout: `${out}\n`, stderr: '', outputFiles: [] }
  }
}

function fakeAgent(sandbox: FakeSandbox): LocalAgent {
  return { sandbox: sandbox as unknown as Sandbox } as unknown as LocalAgent
}

function file(name: string, isDir = false): FileInfo {
  return { name, isDir }
}

function repoTree(): Record<string, FileInfo[]> {
  return {
    '.': [
      file('AGENTS.md'),
      file('README.md'),
      file('harness-py', true),
      file('node_modules', true),
      file('.git', true),
    ],
    'harness-py': [file('AGENTS.md'), file('README.md'), file('src', true)],
    'harness-py/src': [file('AGENTS.md')],
  }
}

describe('EnvironmentContext', () => {
  it('injects env, AGENTS.md contents, and nearby links', async () => {
    const sandbox = new FakeSandbox({ 'AGENTS.md': 'root agents doc' }, repoTree())
    const out = await renderEnvironment(fakeAgent(sandbox), {})
    expect(out).toContain('<environment>')
    // Platform and cwd come from the sandbox probe (uname/pwd), not the host process.
    expect(out).toContain('Platform: Linux')
    expect(out).toContain('Date:')
    expect(out).toContain('Working directory: /work')
    expect(out).toContain('<AGENTS.md>\nroot agents doc\n</AGENTS.md>')
    expect(out).toContain('harness-py/AGENTS.md')
    expect(out).toContain('harness-py/README.md')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('.git')
  })

  it('reaches nested AGENTS.md within the depth limit', async () => {
    const sandbox = new FakeSandbox({ 'AGENTS.md': 'x' }, repoTree())
    const out = await renderEnvironment(fakeAgent(sandbox), {})
    expect(out).toContain('harness-py/src/AGENTS.md')
  })

  it('omits the AGENTS.md section when there is none', async () => {
    const sandbox = new FakeSandbox({}, { '.': [file('main.ts')] })
    const out = await renderEnvironment(fakeAgent(sandbox), {})
    expect(out).not.toContain('<AGENTS.md>')
    expect(out).toContain('<environment>')
  })

  it('truncates an oversize AGENTS.md', async () => {
    const big = 'a'.repeat(AGENTS_MD_CAP + 500)
    const sandbox = new FakeSandbox({ 'AGENTS.md': big }, { '.': [file('AGENTS.md')] })
    const out = await renderEnvironment(fakeAgent(sandbox), {})
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(big.length)
  })

  it('omits platform and working directory when the probes fail', async () => {
    const sandbox = new FakeSandbox({ 'AGENTS.md': 'x' }, { '.': [file('AGENTS.md')] }, null)
    const out = await renderEnvironment(fakeAgent(sandbox), {})
    expect(out).not.toContain('Working directory')
    expect(out).not.toContain('Platform')
    expect(out).toContain('Date:')
  })

  it('memoizes discovery across turns', async () => {
    const sandbox = new FakeSandbox({ 'AGENTS.md': 'x' }, repoTree())
    const memo: EnvironmentMemo = {}
    await renderEnvironment(fakeAgent(sandbox), memo)
    const afterFirst = sandbox.listCalls
    await renderEnvironment(fakeAgent(sandbox), memo)
    expect(sandbox.listCalls).toBe(afterFirst)
  })

  it('is enabled by default and opts out with an empty list', async () => {
    const agent = await createHarness()
    expect(plugins(agent).some((p) => p instanceof EnvironmentContext)).toBe(true)
    const bare = await createHarness({ builtinPlugins: [] })
    expect(plugins(bare).some((p) => p instanceof EnvironmentContext)).toBe(false)
  })
})
