import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentSkills } from '../agent-skills.js'
import { Skill } from '../skill.js'
import { BeforeInvocationEvent } from '../../../hooks/events.js'
import { TextBlock, CachePointBlock } from '../../../types/messages.js'
import { createMockAgent, invokeTrackedHook, type MockAgent } from '../../../__fixtures__/agent-helpers.js'
import { promises as fs } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

describe('AgentSkills', () => {
  let testDir: string

  const createSkillDir = async (
    name: string,
    content: string,
    extraFiles?: Record<string, string>
  ): Promise<string> => {
    const dirPath = path.join(testDir, name)
    await fs.mkdir(dirPath, { recursive: true })
    await fs.writeFile(path.join(dirPath, 'SKILL.md'), content, 'utf-8')
    if (extraFiles) {
      for (const [filePath, fileContent] of Object.entries(extraFiles)) {
        const fullPath = path.join(dirPath, filePath)
        await fs.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.writeFile(fullPath, fileContent, 'utf-8')
      }
    }
    return dirPath
  }

  const makeSkill = (name: string, description = `Description of ${name}`, instructions = `Instructions for ${name}`) =>
    new Skill({ name, description, instructions })

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `agent-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  // ── Constructor & skill resolution ──────────────────────────────────

  describe('constructor', () => {
    it('resolves Skill instances directly', async () => {
      const skill = makeSkill('my-skill')
      const plugin = new AgentSkills({ skills: [skill] })
      expect(await plugin.getAvailableSkills()).toHaveLength(1)
      expect((await plugin.getAvailableSkills())[0]!.name).toBe('my-skill')
    })

    it('resolves a skill directory path', async () => {
      await createSkillDir('my-skill', '---\nname: my-skill\ndescription: A skill\n---\nBody.')
      const plugin = new AgentSkills({ skills: [path.join(testDir, 'my-skill')] })
      const agent = createMockAgent()
      await plugin.initAgent(agent)
      expect(await plugin.getAvailableSkills(agent)).toHaveLength(1)
    })

    it('resolves a parent directory with multiple skills', async () => {
      await createSkillDir('skill-a', '---\nname: skill-a\ndescription: Skill A\n---\nA.')
      await createSkillDir('skill-b', '---\nname: skill-b\ndescription: Skill B\n---\nB.')
      const plugin = new AgentSkills({ skills: [testDir] })
      const agent = createMockAgent()
      await plugin.initAgent(agent)
      expect(await plugin.getAvailableSkills(agent)).toHaveLength(2)
    })

    it('handles mixed sources', async () => {
      await createSkillDir('file-skill', '---\nname: file-skill\ndescription: From file\n---\nBody.')
      const directSkill = makeSkill('direct-skill')
      const plugin = new AgentSkills({
        skills: [directSkill, path.join(testDir, 'file-skill')],
      })
      const agent = createMockAgent()
      await plugin.initAgent(agent)
      expect(await plugin.getAvailableSkills(agent)).toHaveLength(2)
    })

    it('warns on duplicate names and keeps the last', async () => {
      const skill1 = makeSkill('dup', 'First')
      const skill2 = makeSkill('dup', 'Second')
      const plugin = new AgentSkills({ skills: [skill1, skill2] })
      expect(await plugin.getAvailableSkills()).toHaveLength(1)
      expect((await plugin.getAvailableSkills())[0]!.description).toBe('Second')
    })

    it('warns and skips non-existent paths', async () => {
      const plugin = new AgentSkills({ skills: ['/does/not/exist'] })
      expect(await plugin.getAvailableSkills()).toHaveLength(0)
    })

    it('gracefully handles a path with malformed SKILL.md', async () => {
      const dirPath = path.join(testDir, 'bad-skill')
      await fs.mkdir(dirPath, { recursive: true })
      await fs.writeFile(path.join(dirPath, 'SKILL.md'), 'totally broken, no frontmatter at all', 'utf-8')

      const plugin = new AgentSkills({ skills: [dirPath] })
      await plugin.initAgent(createMockAgent())
      expect(await plugin.getAvailableSkills()).toHaveLength(0)
    })

    it('loads valid skills from a parent dir containing malformed siblings', async () => {
      await fs.mkdir(path.join(testDir, 'good-skill'), { recursive: true })
      await fs.writeFile(
        path.join(testDir, 'good-skill', 'SKILL.md'),
        '---\nname: good-skill\ndescription: Works\n---\nBody.',
        'utf-8'
      )
      await fs.mkdir(path.join(testDir, 'bad-skill'), { recursive: true })
      await fs.writeFile(path.join(testDir, 'bad-skill', 'SKILL.md'), 'no frontmatter', 'utf-8')

      const plugin = new AgentSkills({ skills: [testDir] })
      const agent = createMockAgent()
      await plugin.initAgent(agent)
      const skills = await plugin.getAvailableSkills(agent)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe('good-skill')
    })
  })

  // ── Plugin interface ────────────────────────────────────────────────

  describe('plugin interface', () => {
    it('has the correct name', () => {
      const plugin = new AgentSkills({ skills: [makeSkill('s')] })
      expect(plugin.name).toBe('strands:agent-skills')
    })

    it('returns one tool named skills from getTools', () => {
      const plugin = new AgentSkills({ skills: [makeSkill('s')] })
      const tools = plugin.getTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('skills')
    })

    it('registers a BeforeInvocationEvent hook in initAgent', async () => {
      const plugin = new AgentSkills({ skills: [makeSkill('s')] })
      const agent = createMockAgent()
      await plugin.initAgent(agent)
      expect(agent.trackedHooks).toHaveLength(1)
      expect(agent.trackedHooks[0]!.eventType).toBe(BeforeInvocationEvent)
    })
  })

  // ── System prompt injection ─────────────────────────────────────────

  describe('system prompt injection', () => {
    let plugin: AgentSkills
    let agent: MockAgent

    beforeEach(async () => {
      plugin = new AgentSkills({
        skills: [makeSkill('pdf-skill', 'Process PDFs')],
      })
      agent = createMockAgent()
      await plugin.initAgent(agent)
    })

    const fireBeforeInvocation = async () => {
      await invokeTrackedHook(agent, new BeforeInvocationEvent({ agent: agent as any, invocationState: {} }))
    }

    it('injects into undefined system prompt', async () => {
      delete (agent as any).systemPrompt
      await fireBeforeInvocation()
      expect(typeof agent.systemPrompt).toBe('string')
      expect(agent.systemPrompt as unknown as string).toContain('<available_skills>')
      expect(agent.systemPrompt as unknown as string).toContain('pdf-skill')
    })

    it('injects into string system prompt', async () => {
      agent.systemPrompt = 'You are a helpful assistant.'
      await fireBeforeInvocation()
      const prompt = agent.systemPrompt as string
      expect(prompt).toContain('You are a helpful assistant.')
      expect(prompt).toContain('<available_skills>')
      expect(prompt).toContain('pdf-skill')
    })

    it('injects into SystemContentBlock[] prompt', async () => {
      agent.systemPrompt = [new TextBlock('You are helpful.'), new CachePointBlock({ cacheType: 'default' })]
      await fireBeforeInvocation()
      const blocks = agent.systemPrompt as any[]
      expect(blocks.length).toBe(3)
      // Original blocks preserved
      expect(blocks[0]).toBeInstanceOf(TextBlock)
      expect((blocks[0] as TextBlock).text).toBe('You are helpful.')
      expect(blocks[1]).toBeInstanceOf(CachePointBlock)
      // New skills block appended
      expect(blocks[2]).toBeInstanceOf(TextBlock)
      expect((blocks[2] as TextBlock).text).toContain('<available_skills>')
    })

    it('is idempotent — re-injection replaces previous block', async () => {
      agent.systemPrompt = 'Base prompt.'
      await fireBeforeInvocation()
      const first = agent.systemPrompt as string
      const skillsCount = (first.match(/<available_skills>/g) ?? []).length
      expect(skillsCount).toBe(1)

      // Fire again
      await fireBeforeInvocation()
      const second = agent.systemPrompt as string
      const skillsCount2 = (second.match(/<available_skills>/g) ?? []).length
      expect(skillsCount2).toBe(1)
      expect(second).toContain('Base prompt.')
    })

    it('is idempotent with SystemContentBlock[] prompt', async () => {
      agent.systemPrompt = [new TextBlock('Base.')]
      await fireBeforeInvocation()
      await fireBeforeInvocation()
      const blocks = agent.systemPrompt as any[]
      // Original block + one skills block (not two)
      const skillsBlocks = blocks.filter((b: any) => b instanceof TextBlock && b.text.includes('<available_skills>'))
      expect(skillsBlocks).toHaveLength(1)
    })

    it('preserves external modifications to system prompt', async () => {
      agent.systemPrompt = 'Original.'
      await fireBeforeInvocation()

      // Simulate external modification
      agent.systemPrompt = (agent.systemPrompt as string).replace('Original.', 'Modified.')

      await fireBeforeInvocation()
      const prompt = agent.systemPrompt as string
      expect(prompt).toContain('Modified.')
      expect(prompt).toContain('<available_skills>')
    })

    it('XML-escapes special characters in skill metadata', async () => {
      const plugin2 = new AgentSkills({
        skills: [makeSkill('test-skill', 'Use when: user says <hello> & "goodbye"')],
      })
      const agent2 = createMockAgent()
      await plugin2.initAgent(agent2)

      const hook = agent2.trackedHooks[0]!
      await hook.callback(new BeforeInvocationEvent({ agent: agent2 as any, invocationState: {} }))

      const prompt = agent2.systemPrompt as string
      expect(prompt).toContain('&lt;hello&gt;')
      expect(prompt).toContain('&amp;')
      expect(prompt).toContain('&quot;goodbye&quot;')
    })

    it('includes skill location when path is set', async () => {
      const dirPath = await createSkillDir(
        'located-skill',
        '---\nname: located-skill\ndescription: Has a path\n---\nBody.'
      )
      const filePlugin = new AgentSkills({ skills: [dirPath] })
      const fileAgent = createMockAgent()
      await filePlugin.initAgent(fileAgent)
      await invokeTrackedHook(fileAgent, new BeforeInvocationEvent({ agent: fileAgent as any, invocationState: {} }))

      const prompt = fileAgent.systemPrompt as string
      expect(prompt).toContain('<location>')
      expect(prompt).toContain('SKILL.md')
    })

    it('shows "no skills available" when empty', async () => {
      const emptyPlugin = new AgentSkills({ skills: [] })
      const emptyAgent = createMockAgent()
      await emptyPlugin.initAgent(emptyAgent)
      await invokeTrackedHook(emptyAgent, new BeforeInvocationEvent({ agent: emptyAgent as any, invocationState: {} }))

      const prompt = emptyAgent.systemPrompt as string
      expect(prompt).toContain('No skills are currently available.')
    })

    it('injects into null system prompt', async () => {
      agent.systemPrompt = null as any
      await fireBeforeInvocation()
      expect(typeof agent.systemPrompt).toBe('string')
      expect(agent.systemPrompt as unknown as string).toContain('<available_skills>')
      expect(agent.systemPrompt as unknown as string).toContain('pdf-skill')
    })

    it('reflects updated skills after setAvailableSkills', async () => {
      agent.systemPrompt = 'Base.'
      await fireBeforeInvocation()
      expect(agent.systemPrompt as string).toContain('pdf-skill')

      plugin.setAvailableSkills([makeSkill('new-skill', 'A new skill')])
      await fireBeforeInvocation()
      const prompt = agent.systemPrompt as string
      expect(prompt).toContain('new-skill')
      expect(prompt).not.toContain('pdf-skill')
      expect(prompt).toContain('Base.')
    })

    it('lists all skills when multiple are available', async () => {
      const multiPlugin = new AgentSkills({
        skills: [makeSkill('skill-a', 'First'), makeSkill('skill-b', 'Second'), makeSkill('skill-c', 'Third')],
      })
      const multiAgent = createMockAgent()
      await multiPlugin.initAgent(multiAgent)
      await invokeTrackedHook(multiAgent, new BeforeInvocationEvent({ agent: multiAgent as any, invocationState: {} }))

      const prompt = multiAgent.systemPrompt as string
      expect(prompt).toContain('skill-a')
      expect(prompt).toContain('skill-b')
      expect(prompt).toContain('skill-c')
      expect(prompt).toContain('First')
      expect(prompt).toContain('Second')
      expect(prompt).toContain('Third')
    })
  })

  // ── Tool callback ───────────────────────────────────────────────────

  describe('tool callback', () => {
    let plugin: AgentSkills
    let agent: MockAgent

    beforeEach(async () => {
      plugin = new AgentSkills({
        skills: [
          new Skill({
            name: 'test-skill',
            description: 'A test skill',
            instructions: '# Test\nDo the thing.',
            allowedTools: ['bash'],
            compatibility: 'v1.0+',
          }),
        ],
      })
      agent = createMockAgent()
      await plugin.initAgent(agent)
    })

    const invokeTool = async (skillName: string): Promise<string> => {
      const tools = plugin.getTools()
      const skillsTool = tools[0]!
      // Use the stream method to get the result
      const gen = skillsTool.stream({
        toolUse: { name: 'skills', toolUseId: 'test-id', input: { skill_name: skillName } },
        agent: agent as any,
        invocationState: {},
        cancelSignal: agent.cancelSignal,
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
      })
      let result = await gen.next()
      while (!result.done) {
        result = await gen.next()
      }
      // Extract text from the tool result
      const content = result.value.content
      return content.map((b: any) => b.text ?? '').join('')
    }

    it('returns instructions for a valid skill', async () => {
      const result = await invokeTool('test-skill')
      expect(result).toContain('# Test')
      expect(result).toContain('Do the thing.')
    })

    it('includes metadata in the response', async () => {
      const result = await invokeTool('test-skill')
      expect(result).toContain('Allowed tools: bash')
      expect(result).toContain('Compatibility: v1.0+')
    })

    it('returns error for unknown skill', async () => {
      const result = await invokeTool('nonexistent')
      expect(result).toContain("Skill 'nonexistent' not found")
      expect(result).toContain('test-skill')
    })

    it('tracks activated skills in appState', async () => {
      await invokeTool('test-skill')
      const activated = plugin.getActivatedSkills(agent as any)
      expect(activated).toEqual(['test-skill'])
    })

    it('maintains activation order without duplicates', async () => {
      // Add a second skill
      plugin.setAvailableSkills([makeSkill('skill-a'), makeSkill('skill-b')])

      await invokeTool('skill-a')
      await invokeTool('skill-b')
      await invokeTool('skill-a') // re-activate

      const activated = plugin.getActivatedSkills(agent as any)
      expect(activated).toEqual(['skill-b', 'skill-a'])
    })

    it('handles skill with no instructions', async () => {
      plugin.setAvailableSkills([new Skill({ name: 'empty', description: 'No instructions' })])
      const result = await invokeTool('empty')
      expect(result).toContain("Skill 'empty' activated (no instructions available).")
    })

    it('returns validation error for empty skill_name', async () => {
      const result = await invokeTool('')
      // z.string().min(1) rejects empty strings at the schema level
      expect(result.toLowerCase()).toContain('too_small')
    })
  })

  // ── Resource listing ────────────────────────────────────────────────

  describe('resource listing', () => {
    it('lists files from scripts/, references/, assets/', async () => {
      const dirPath = await createSkillDir(
        'resource-skill',
        '---\nname: resource-skill\ndescription: Has resources\n---\nBody.',
        {
          'scripts/setup.sh': '#!/bin/bash',
          'references/api.md': '# API Docs',
          'assets/logo.png': 'binary',
        }
      )
      const plugin2 = new AgentSkills({ skills: [dirPath] })
      const agent2 = createMockAgent()
      await plugin2.initAgent(agent2)

      const tools = plugin2.getTools()
      const gen = tools[0]!.stream({
        toolUse: { name: 'skills', toolUseId: 'id', input: { skill_name: 'resource-skill' } },
        agent: agent2 as any,
        invocationState: {},
        cancelSignal: agent2.cancelSignal,
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
      })
      let result = await gen.next()
      while (!result.done) result = await gen.next()
      const text = result.value.content.map((b: any) => b.text ?? '').join('')

      expect(text).toContain('scripts/setup.sh')
      expect(text).toContain('references/api.md')
      expect(text).toContain('assets/logo.png')
    })

    it('handles missing resource directories gracefully', async () => {
      const dirPath = await createSkillDir(
        'no-resources',
        '---\nname: no-resources\ndescription: No extras\n---\nBody.'
      )
      const plugin2 = new AgentSkills({ skills: [dirPath] })
      const agent2 = createMockAgent()
      await plugin2.initAgent(agent2)

      const tools = plugin2.getTools()
      const gen = tools[0]!.stream({
        toolUse: { name: 'skills', toolUseId: 'id', input: { skill_name: 'no-resources' } },
        agent: agent2 as any,
        invocationState: {},
        cancelSignal: agent2.cancelSignal,
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
      })
      let result = await gen.next()
      while (!result.done) result = await gen.next()
      const text = result.value.content.map((b: any) => b.text ?? '').join('')

      expect(text).not.toContain('Available resources')
    })

    it('truncates at maxResourceFiles', async () => {
      // Create more files than the limit
      const files: Record<string, string> = {}
      for (let i = 0; i < 5; i++) {
        files[`scripts/file${i}.sh`] = `script ${i}`
      }
      const dirPath = await createSkillDir(
        'many-files',
        '---\nname: many-files\ndescription: Many resources\n---\nBody.',
        files
      )
      const plugin2 = new AgentSkills({ skills: [dirPath], maxResourceFiles: 3 })
      const agent2 = createMockAgent()
      await plugin2.initAgent(agent2)

      const tools = plugin2.getTools()
      const gen = tools[0]!.stream({
        toolUse: { name: 'skills', toolUseId: 'id', input: { skill_name: 'many-files' } },
        agent: agent2 as any,
        invocationState: {},
        cancelSignal: agent2.cancelSignal,
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
      })
      let result = await gen.next()
      while (!result.done) result = await gen.next()
      const text = result.value.content.map((b: any) => b.text ?? '').join('')

      expect(text).toContain('truncated at 3 files')
    })
  })

  // ── setAvailableSkills / getAvailableSkills ─────────────────────────

  describe('setAvailableSkills', () => {
    it('replaces all skills', async () => {
      const plugin2 = new AgentSkills({ skills: [makeSkill('original')] })
      expect(await plugin2.getAvailableSkills()).toHaveLength(1)

      plugin2.setAvailableSkills([makeSkill('new-a'), makeSkill('new-b')])
      expect(await plugin2.getAvailableSkills()).toHaveLength(2)
      expect((await plugin2.getAvailableSkills()).map((s) => s.name).sort()).toEqual(['new-a', 'new-b'])
    })
  })

  // ── URL skill resolution ──────────────────────────────────────────────

  describe('URL skill resolution', () => {
    const SAMPLE_CONTENT = '---\nname: url-skill\ndescription: A URL skill\n---\n# Instructions\n'

    const mockFetchSuccess = (content: string) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(content),
      } as Response)
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('resolves a URL string as a skill source', async () => {
      mockFetchSuccess(SAMPLE_CONTENT)

      const plugin = new AgentSkills({ skills: ['https://example.com/SKILL.md'] })
      await plugin.initAgent(createMockAgent())

      expect(await plugin.getAvailableSkills()).toHaveLength(1)
      expect((await plugin.getAvailableSkills())[0]!.name).toBe('url-skill')
    })

    it('resolves a mix of URL and local filesystem sources', async () => {
      mockFetchSuccess(SAMPLE_CONTENT)

      await createSkillDir('local-skill', '---\nname: local-skill\ndescription: A local skill\n---\nBody.')

      const plugin = new AgentSkills({
        skills: ['https://example.com/SKILL.md', path.join(testDir, 'local-skill')],
      })
      const agent = createMockAgent()
      await plugin.initAgent(agent)

      expect(await plugin.getAvailableSkills(agent)).toHaveLength(2)
      const names = new Set((await plugin.getAvailableSkills(agent)).map((s) => s.name))
      expect(names).toEqual(new Set(['url-skill', 'local-skill']))
    })

    it('skips a failed URL fetch gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve(''),
      } as Response)

      const plugin = new AgentSkills({ skills: ['https://example.com/broken/SKILL.md'] })
      await plugin.initAgent(createMockAgent())

      expect(await plugin.getAvailableSkills()).toHaveLength(0)
    })

    it('warns on duplicate skill names from URLs', async () => {
      mockFetchSuccess(SAMPLE_CONTENT)

      const plugin = new AgentSkills({
        skills: ['https://example.com/a/SKILL.md', 'https://example.com/b/SKILL.md'],
      })
      await plugin.initAgent(createMockAgent())

      expect(await plugin.getAvailableSkills()).toHaveLength(1)
    })

    it('awaits URL sources in initAgent', async () => {
      mockFetchSuccess(SAMPLE_CONTENT)

      const plugin = new AgentSkills({ skills: ['https://example.com/SKILL.md'] })
      const agent = createMockAgent()
      await plugin.initAgent(agent)

      expect(await plugin.getAvailableSkills()).toHaveLength(1)
      expect(agent.trackedHooks).toHaveLength(1)
    })
  })
})
