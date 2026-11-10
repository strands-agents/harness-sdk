import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Agent } from '$/sdk/index.js'
import { AgentSkills, Skill } from '$/sdk/vended-plugins/skills/index.js'
import { getMessageText } from '../__fixtures__/model-test-helpers.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { promises as fs } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

describe.skipIf(bedrock.skip)('AgentSkills Plugin Integration', () => {
  const SECRET_CODEWORD = 'PAPAYA7'
  const ALT_SECRET_CODEWORD = 'MANGO9'

  const summarizationSkill = new Skill({
    name: 'summarization',
    description: 'Summarize text into concise bullet points',
    instructions: `You are a summarization expert. When this skill is activated, summarize the provided text.
The secret codeword is: ${SECRET_CODEWORD}. Always include this codeword in your response.`,
  })

  const translationSkill = new Skill({
    name: 'translation',
    description: 'Translate text between languages',
    instructions: 'You are a translation expert. Translate the provided text accurately.',
  })

  const createModel = () =>
    bedrock.createModel({
      maxTokens: 1024,
    })

  describe('agent activates skill and uses instructions', () => {
    it('activates a skill via prompt and includes the secret codeword', async () => {
      const plugin = new AgentSkills({
        skills: [summarizationSkill, translationSkill],
      })

      const agent = new Agent({
        model: createModel(),
        plugins: [plugin],
        printer: false,
      })

      const result = await agent.invoke(
        'Activate the summarization skill and tell me the secret codeword from its instructions.'
      )

      const responseText = getMessageText(result.lastMessage)

      // Verify the model used the skills tool
      const toolUseMessage = agent.messages.find((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'skills')
      )
      expect(toolUseMessage).toBeDefined()

      // Verify the model found the secret codeword from the skill instructions
      expect(responseText).toContain(SECRET_CODEWORD)

      // Verify the system prompt has skill metadata injected
      const systemPrompt = agent.systemPrompt as string
      expect(systemPrompt).toContain('<available_skills>')
      expect(systemPrompt).toContain('summarization')
      expect(systemPrompt).toContain('translation')
    })
  })

  describe('skill activation state persistence', () => {
    it('tracks activated skills in agent appState', async () => {
      const plugin = new AgentSkills({
        skills: [summarizationSkill, translationSkill],
      })

      const agent = new Agent({
        model: createModel(),
        plugins: [plugin],
        printer: false,
      })

      // Activate the first skill
      await agent.invoke('Activate the summarization skill.')
      let activated = plugin.getActivatedSkills(agent)
      expect(activated).toContain('summarization')

      // Activate the second skill
      await agent.invoke('Now activate the translation skill.')
      activated = plugin.getActivatedSkills(agent)
      expect(activated).toContain('summarization')
      expect(activated).toContain('translation')
    })
  })

  describe('load skills from filesystem', () => {
    let testDir: string

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `skills-integ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await fs.mkdir(testDir, { recursive: true })
    })

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true })
    })

    it('loads a skill from disk and activates it', async () => {
      // Create a skill directory with SKILL.md
      const skillDir = path.join(testDir, 'code-review')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: code-review
description: Review code for bugs and improvements
---
You are a code review expert. When reviewing code, look for bugs, security issues, and performance improvements.
The secret codeword for this skill is: ${ALT_SECRET_CODEWORD}.`,
        'utf-8'
      )

      const plugin = new AgentSkills({
        skills: [testDir],
      })

      const agent = new Agent({
        model: createModel(),
        plugins: [plugin],
        printer: false,
      })
      await agent.initialize()

      // Verify the skill was loaded from the directory (path-based skills load during initAgent)
      const availableSkills = await plugin.getAvailableSkills(agent)
      expect(availableSkills).toHaveLength(1)
      expect(availableSkills[0]!.name).toBe('code-review')

      const result = await agent.invoke(
        'Activate the code-review skill and tell me the secret codeword from its instructions.'
      )

      const responseText = getMessageText(result.lastMessage)
      expect(responseText).toContain(ALT_SECRET_CODEWORD)
    })
  })

  describe('system prompt marker replacement', () => {
    it('replaces the skills block with updated content between invocations', async () => {
      const plugin = new AgentSkills({
        skills: [summarizationSkill],
      })

      const agent = new Agent({
        model: createModel(),
        plugins: [plugin],
        printer: false,
        systemPrompt: 'You are a helpful assistant.',
      })

      // First invocation — only summarization is available
      await agent.invoke('Hello.')

      const promptAfterFirst = agent.systemPrompt as string
      expect((promptAfterFirst.match(/<available_skills>/g) ?? []).length).toBe(1)
      expect(promptAfterFirst).toContain('You are a helpful assistant.')
      expect(promptAfterFirst).toContain('summarization')
      expect(promptAfterFirst).not.toContain('translation')

      // Swap the skill set between invocations
      plugin.setAvailableSkills([translationSkill])

      // Second invocation — only translation should appear, summarization gone
      await agent.invoke('Hello again.')

      const promptAfterSecond = agent.systemPrompt as string
      expect((promptAfterSecond.match(/<available_skills>/g) ?? []).length).toBe(1)
      expect(promptAfterSecond).toContain('You are a helpful assistant.')
      expect(promptAfterSecond).toContain('translation')
      expect(promptAfterSecond).not.toContain('summarization')
    })
  })
})
