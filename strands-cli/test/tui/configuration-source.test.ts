import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'

import { configurationSource } from '../../src/tui/configuration-source.js'
import { exportSourceProject, writeAgentProject } from '../../src/tui/project/export.js'
import { resolveSkillPaths } from '../../src/tui/skills.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('live configuration source', () => {
  it('renders the current profile as TypeScript and Python harness source', () => {
    const source = configurationSource(defineHarnessAgentConfig({ name: 'Live config' }))

    expect(source.preferredLanguage).toBe('typescript')
    expect(source.documents.typescript.source).toContain('await createHarness({')
    expect(source.documents.typescript.source).toContain("name: 'Live config'")
    expect(source.documents.python.source).toContain('create_harness(')
    expect(source.documents.python.source).toContain('name="Live config"')
  })

  it.each(['typescript', 'python'] as const)('matches the packaged %s entrypoint byte for byte', async (language) => {
    const root = mkdtempSync(join(tmpdir(), 'strands-live-config-'))
    temporaryDirectories.push(root)
    const extension = language === 'python' ? 'py' : 'ts'
    mkdirSync(join(root, 'skills', 'review'), { recursive: true })
    writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review')
    writeFileSync(join(root, 'approval.cedar'), 'permit(principal, action, resource);')
    writeFileSync(
      join(root, `tool.${extension}`),
      language === 'python'
        ? 'from strands import tool\n@tool\ndef ping():\n    """Ping."""\n    return "pong"\n'
        : "import { tool } from '@strands-agents/sdk'\nexport const ping = tool({ name: 'ping', description: 'Ping', callback: () => 'pong' })\n"
    )
    const skillSources = ['./skills', 'https://example.com/SKILL.md']
    const profile = defineHarnessAgentConfig({
      instructions: 'Keep the source and export in sync.',
      tools: [{ kind: 'tool', module: `./tool.${extension}`, export: 'ping', files: [`./tool.${extension}`] }],
      skills: skillSources,
      interventions: './approval.cedar',
      session: true,
      memory: true,
    })
    const preview = configurationSource(profile, undefined, root).documents[language]
    const archive = join(root, 'agent.zip')
    await writeAgentProject(profile, language, resolveSkillPaths(skillSources, root, false), archive, root)
    const entries = unzipSync(readFileSync(archive))

    expect(preview.error).toBeUndefined()
    expect(preview.source).toBe(Buffer.from(entries[`agent/agent.${extension}`]!).toString())
    expect(preview.source).toContain('./agent/skills')
    expect(preview.source).toContain('./agent/tools/')
    expect(preview.source).toContain('./agent/policies/')
    expect(preview.source).not.toContain(root)
  })

  it.each(['typescript', 'python'] as const)('previews only the exportable authored %s source', async (language) => {
    const root = mkdtempSync(join(tmpdir(), 'strands-live-config-'))
    temporaryDirectories.push(root)
    const filename = `agent.${language === 'python' ? 'py' : 'ts'}`
    const entrypoint = join(root, filename)
    const authored =
      language === 'python'
        ? 'from strands_harness import create_harness\nagent = create_harness()\n'
        : "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({})\n"
    writeFileSync(entrypoint, authored)
    const project = { root, entrypoint, language }
    const source = configurationSource(defineHarnessAgentConfig({}), project)
    const archive = join(root, 'project.zip')
    await exportSourceProject(project, 'Authored', language, [], archive)
    const entries = unzipSync(readFileSync(archive))
    const alternate = language === 'python' ? 'typescript' : 'python'

    expect(source.documents[language]).toEqual({ source: authored, generated: false, path: entrypoint })
    expect(source.documents[language].source).toBe(Buffer.from(entries[filename]!).toString())
    expect(source.documents[alternate]).toMatchObject({ source: '', error: expect.stringContaining('same language') })
  })

  it('reports an unreadable authored entrypoint instead of substituting generated code', () => {
    const source = configurationSource(defineHarnessAgentConfig({ name: 'Different agent' }), {
      root: '/missing/project',
      entrypoint: '/missing/project/agent.ts',
      language: 'typescript',
    })

    expect(source.documents.typescript).toMatchObject({
      source: '',
      generated: false,
      error: expect.stringContaining('Could not read'),
    })
  })

  it('reports the same preparation error as export for an unpackaged local module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strands-live-config-'))
    temporaryDirectories.push(root)
    writeFileSync(join(root, 'tool.ts'), 'export const tool = {}\n')
    const profile = defineHarnessAgentConfig({ tools: [{ kind: 'tool', module: './tool.ts' }] })
    const preview = configurationSource(profile, undefined, root).documents.typescript

    expect(preview.error).toContain('files')
    await expect(writeAgentProject(profile, 'typescript', [], join(root, 'agent.zip'), root)).rejects.toThrow(
      preview.error
    )
  })
})
