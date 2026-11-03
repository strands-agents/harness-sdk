import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { Agent } from '@strands-agents/sdk'
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { createInteractiveChat } from '../../src/ui/chat/runtime.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'

import {
  configuredSkillSources,
  defaultSkillPaths,
  AgentSkillsRuntime,
  resolveSkillPaths,
} from '../../src/agent/skills.js'

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
        join(home, '.strands', 'skills'),
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
      expect(configuredSkillSources(undefined, cwd)).toEqual([])
      expect(configuredSkillSources(['./custom/skills', 'https://example.com/SKILL.md'], cwd)).toEqual([
        configured,
        'https://example.com/SKILL.md',
      ])

      expect(resolveSkillPaths('./custom/skills', cwd, false)).toEqual([configured])
      expect(resolveSkillPaths('https://example.com/SKILL.md', cwd, false)).toEqual(['https://example.com/SKILL.md'])
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
      const plugin = new AgentSkills({ skills: [user, project] })
      const agent = new Agent({ plugins: [plugin] })
      await agent.initialize()
      const runtime = new AgentSkillsRuntime(
        () => agent,
        () => plugin
      )
      const skills = await runtime.list()
      expect(skills.map((skill) => ({ ...skill, path: skill.path && normalize(skill.path) }))).toMatchObject([
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

  it.each(['instance', 'plugin', 'url', 'plugins'] as const)(
    'shows the active agent catalog for configured %s skills',
    async (source) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-skills-runtime-'))
      const skill = new Skill({ name: 'review', description: 'Review', instructions: 'Review the code.' })
      const plugin = new AgentSkills({ skills: [skill] })
      if (source === 'url') {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new globalThis.Response('---\nname: review\ndescription: Review\n---\nReview the code.'))
        )
      }
      let chat: Awaited<ReturnType<typeof createInteractiveChat>> | undefined
      try {
        chat = await createInteractiveChat({
          cwd: directory,
          sessionRoot: join(directory, 'catalog'),
          config: CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false }),
          agentOptions: {
            model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
            session: false,
            memory: false,
            builtinTools: [],
            builtinPlugins: [],
            contextManager: false,
            backgroundTasks: false,
            caching: false,
            skills: { instance: skill, plugin, url: 'https://example.invalid/review/SKILL.md', plugins: false }[source],
            ...(source === 'plugins' ? { plugins: [plugin] } : {}),
          },
        })
        await chat.submit('/skills')
        expect(chat.getSnapshot().panel).toMatchObject({
          title: 'Skills (1)',
          rows: [{ label: 'review', description: 'Review' }],
        })
        expect(chat.backend.info?.().tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'skills' })])
        )
      } finally {
        await chat?.dispose()
        vi.unstubAllGlobals()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('uses the plugin state key and activates without synthetic tool messages', async () => {
    const skill = new Skill({ name: 'review', description: 'Review', instructions: 'Review the code.' })
    const plugin = new AgentSkills({ skills: [skill], stateKey: 'custom_skills' })
    const agent = new Agent({ plugins: [plugin] })
    await agent.initialize()
    const runtime = new AgentSkillsRuntime(
      () => agent,
      () => plugin
    )

    await expect(runtime.list()).resolves.toMatchObject([{ name: 'review', active: false }])
    await expect(runtime.activate('REVIEW')).resolves.toMatchObject({
      skill: { name: 'review', active: true },
      content: expect.stringContaining('Review the code.'),
    })
    await expect(runtime.list()).resolves.toMatchObject([{ name: 'review', active: true }])
    expect(agent.messages).toEqual([])
    await expect(runtime.activate('missing')).resolves.toBeUndefined()
  })

  it('keeps exact skill identities when names share a displayed label or differ only in case', async () => {
    const names = ['review', 'review\u001b[31m', 'REVIEW']
    const plugin = new AgentSkills({
      skills: names.map((name, index) => new Skill({ name, description: 'Review', instructions: `Review ${index}` })),
    })
    const agent = new Agent({ plugins: [plugin], printer: false })
    await agent.initialize()
    const runtime = new AgentSkillsRuntime(
      () => agent,
      () => plugin
    )
    const stream = vi.fn(idleBackend().stream)
    const controller = new ChatController(idleBackend({ stream }), { skills: runtime })

    await controller.submit('/skills')
    const rows = controller.getSnapshot().panel!.rows
    expect(rows.filter((row) => row.label === 'review')).toHaveLength(2)
    expect(new Set(rows.map((row) => row.value)).size).toBe(3)
    expect(controller.commandAssistance('/rev')?.completions.map((command) => command.usage)).toEqual(
      expect.arrayContaining(['/review [request]', '/REVIEW [request]'])
    )
    for (const [index, name] of names.entries()) {
      const row = rows.find((row) => row.value === encodeURIComponent(name))!
      expect(controller.openSkillDetail(decodeURIComponent(row.value!))).toBe(true)
      expect(controller.getSnapshot().panel?.body).toBe(`Review ${index}`)
      await controller.submit(`/${decodeURIComponent(row.value!)}`)
      expect(stream.mock.calls.at(-1)?.[0]).toContain(`Review ${index}`)
      expect(plugin.getActivatedSkills(agent)).toEqual(names.slice(0, index + 1))
    }
    expect(plugin.getActivatedSkills(agent)).toEqual(names)
    expect(agent.messages).toEqual([])
    await controller.dispose()
  })

  it('finishes activation on the agent whose catalog was read', async () => {
    const plugin = new AgentSkills({ skills: [new Skill({ name: 'review', description: 'Review' })] })
    const first = new Agent({ plugins: [plugin], printer: false })
    const second = new Agent({ plugins: [plugin], printer: false })
    await Promise.all([first.initialize(), second.initialize()])
    let selected = first
    const runtime = new AgentSkillsRuntime(
      () => selected,
      () => plugin
    )
    const activation = runtime.activate('review')
    selected = second

    await expect(activation).resolves.toMatchObject({ skill: { active: true } })
    expect(plugin.getActivatedSkills(first)).toEqual(['review'])
    expect(plugin.getActivatedSkills(second)).toEqual([])
  })

  it('does not report activation when a skill disappears after catalog loading', async () => {
    const plugin = new AgentSkills({ skills: [new Skill({ name: 'review', description: 'Review' })] })
    const agent = new Agent({ plugins: [plugin], printer: false })
    await agent.initialize()
    const list = plugin.getAvailableSkills.bind(plugin)
    vi.spyOn(plugin, 'getAvailableSkills').mockImplementationOnce(async (current) => {
      const skills = await list(current)
      plugin.setAvailableSkills([])
      return skills
    })
    const runtime = new AgentSkillsRuntime(
      () => agent,
      () => plugin
    )

    await expect(runtime.activate('review')).rejects.toThrow("Skill 'review' not found")
    expect(plugin.getActivatedSkills(agent)).toEqual([])
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
