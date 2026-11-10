import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

describe('self-building runtime', () => {
  it('reloads real tools, plugins, skills and owned MCP connections from a separate authoring directory', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), join(import.meta.dirname, 'fixtures', 'self-building-runtime.ts')],
      { timeout: 20_000 }
    )
    expect(JSON.parse(stdout)).toMatchObject({
      originalTool: 'first',
      originalPlugin: 'first',
      originalMcp: 'first',
      mcpCwdCorrect: true,
      mcpPanel: 'MCP servers (1)',
      updatedTool: 'later',
      updatedPlugin: 'later',
      updatedSkill: expect.stringContaining('Use later.'),
      retainedTool: 'first',
      oldMcpStopped: true,
      updatedMcp: 'later',
    })
  }, 30_000)
})
