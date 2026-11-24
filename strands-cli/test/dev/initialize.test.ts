import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeWorkspaceBinding } from '../../src/dev/initialize.js'
import { initializeDevWorkspace, readDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => vi.restoreAllMocks())

const legacy = async () => {
  const launch = await temporaryDirectory()
  const root = join(launch, 'strands-dev/base-cli')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"legacy","version":"1.0.0","type":"module"}')
  await writeFile(join(root, 'src/agent.ts'), 'export const agent = {name:"original"}')
  await writeFile(join(root, '.strands-entrypoint'), './src/agent.ts\n')
  const workspace = await initializeDevWorkspace(root, {
    version: 1,
    name: 'Base CLI',
    language: 'typescript',
    entrypoint: 'src/agent.ts',
    origin: { kind: 'cli' },
  })
  return { launch, workspace }
}

describe('workspace initialization', () => {
  it('shouldBindTheLegacyAgentWithoutMovingSource', async () => {
    const { launch, workspace } = await legacy()
    const source = await readFile(workspace.entrypoint, 'utf8')

    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))

    expect(bound.root).toBe(workspace.root)
    expect(bound.entrypoint).toBe(workspace.entrypoint)
    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
    const config = JSON.parse(await readFile(join(launch, 'strands-dev/.config'), 'utf8'))
    expect(config.agent.path).toBe('base-cli')
    expect((await readDevWorkspace(join(launch, 'strands-dev')))?.entrypoint).toBe(workspace.entrypoint)
  })
})
