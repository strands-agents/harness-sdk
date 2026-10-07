import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { importAgentProject } from '../../../src/tui/project/import.js'
import { createCompleteProfileFixture, exportCompleteProfile } from './complete-profile.js'

const run = promisify(execFile)
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-generated-export-'))
  vi.stubEnv('AWS_REGION', 'us-east-1')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('builds and loads the generated TypeScript agent', { timeout: 30_000 }, async () => {
  const fixture = await createCompleteProfileFixture(root)
  const { destination } = await exportCompleteProfile(fixture, fixture.expected)
  const project = importAgentProject(destination)
  await symlink(resolve(import.meta.dirname, '../../../node_modules'), join(project.root, 'node_modules'), 'junction')
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: project.root }).catch(
    (error: unknown) => {
      const details = error as { stdout?: string; stderr?: string }
      throw new Error(`Generated project build failed:\n${details.stdout ?? ''}\n${details.stderr ?? ''}`, {
        cause: error,
      })
    }
  )
  const result = await run(
    process.execPath,
    ['--input-type=module', '--eval', "const {agent}=await import('./dist/agent/agent.js'); console.log(agent.name)"],
    { cwd: project.root }
  )
  expect(result.stdout.trim()).toBe('Chat configured agent')
})
