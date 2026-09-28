import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  configuredSkillPaths,
  defaultSkillPaths,
  discoverSkills,
  FileSkillsRuntime,
  resolveSkillPaths,
} from '../src/tui/skills.js'

describe('skill discovery', () => {
  it('includes conventional user paths and repository ancestors from root to cwd', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-skills-paths-'))
    const home = join(directory, 'home')
    const repository = join(directory, 'repo')
    const nested = join(repository, 'packages', 'app')
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })

    try {
      const paths = defaultSkillPaths(nested, home)
      expect(paths.slice(0, 4)).toEqual([
        join(home, '.agents', 'skills'),
        join(home, '.claude', 'skills'),
        join(home, '.codex', 'skills'),
        join(home, '.strands', 'cli', 'skills'),
      ])
      expect(paths).toContain(join(repository, '.agents', 'skills'))
      expect(paths).toContain(join(repository, '.claude', 'skills'))
      expect(paths).toContain(join(nested, '.agent', 'skills'))
      expect(paths.indexOf(join(repository, '.agents', 'skills'))).toBeLessThan(
        paths.indexOf(join(nested, '.agents', 'skills'))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('appends configured directories after discovered ones and honors the off switch', () => {
    const cwd = join(tmpdir(), 'strands-skills-resolve')
    const configured = join(cwd, 'custom', 'skills')
    vi.stubEnv('STRANDS_CLI_SKILL_DISCOVERY', undefined)
    try {
      const resolved = resolveSkillPaths(['./custom/skills', join(cwd, '.agent', 'skills')], cwd)
      expect(resolved.slice(-2)).toEqual([configured, join(cwd, '.agent', 'skills')])
      expect(resolved.filter((path) => path === join(cwd, '.agent', 'skills'))).toHaveLength(1)
      expect(resolved.length).toBeGreaterThan(2)
      expect(resolveSkillPaths(null, cwd)).toEqual([])
      expect(resolveSkillPaths([], cwd)).toEqual([])
      expect(configuredSkillPaths(undefined, cwd)).toEqual([])
      expect(configuredSkillPaths('./custom/skills', cwd)).toEqual([configured])

      expect(resolveSkillPaths('./custom/skills', cwd, false)).toEqual([configured])
      expect(resolveSkillPaths(undefined, cwd, false)).toEqual([join(cwd, '.agent', 'skills')])

      process.env.STRANDS_CLI_SKILL_DISCOVERY = 'off'
      expect(resolveSkillPaths('./custom/skills', cwd)).toEqual([configured])
      expect(resolveSkillPaths(undefined, cwd)).toEqual([join(cwd, '.agent', 'skills')])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses the later, more specific source when skill names collide', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-skills-precedence-'))
    const user = join(directory, 'user')
    const project = join(directory, 'project')
    await writeSkill(user, 'User review')
    await writeSkill(project, 'Project review')

    try {
      expect(discoverSkills([user, project])).toMatchObject([
        {
          name: 'review',
          description: 'Project review',
          path: join(project, 'review'),
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('activates a discovered skill through the SDK tool without adding synthetic tool messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-skills-activation-'))
    await writeSkill(directory, 'Project review')
    const invoke = vi.fn(async () => ({ status: 'success' as const, content: [] }))
    const agent = {
      appState: { get: () => undefined },
      tool: { skills: { invoke } },
    } as unknown as Agent
    const runtime = new FileSkillsRuntime([directory], () => agent)

    try {
      await expect(runtime.activate('REVIEW')).resolves.toMatchObject({ name: 'review', active: true })
      expect(invoke).toHaveBeenCalledWith({ skill_name: 'review' }, { recordDirectToolCall: false })
      await expect(runtime.activate('missing')).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function writeSkill(parent: string, description: string): Promise<void> {
  const directory = join(parent, 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: review\ndescription: ${description}\n---\n\nFollow the project instructions.\n`
  )
}
