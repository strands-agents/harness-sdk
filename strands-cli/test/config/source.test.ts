import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'

import { configurationSource } from '../../src/config/source.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { agentProjectEditorCommand } from '../../src/terminal/open-editor.js'
import { exportSourceProject, writeAgentProject } from '../../src/project/export.js'
import { importAgentProject } from '../../src/project/import.js'
import { resolveSkillPaths } from '../../src/agent/skills.js'

import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

describe('live configuration source', () => {
  it.each(['typescript', 'python'] as const)('matches the packaged %s entrypoint byte for byte', async (language) => {
    const root = await temporaryDirectory('strands-live-config-')
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
      name: 'Live config',
      instructions: 'Keep the source and export in sync.',
      tools: [{ kind: 'tool', module: `./tool.${extension}`, export: 'ping', files: [`./tool.${extension}`] }],
      skills: skillSources,
      interventions: './approval.cedar',
      session: true,
      memory: true,
    })
    const source = configurationSource(profile, undefined, root)
    const preview = source.documents[language]
    const archive = join(root, 'agent.zip')
    await writeAgentProject(profile, language, resolveSkillPaths(skillSources, root, false), archive, root)
    const entries = unzipSync(readFileSync(archive))

    expect(source.preferredLanguage).toBe('typescript')
    expect(preview.source).toContain(language === 'python' ? 'create_harness(' : 'await createHarness({')
    expect(preview.source).toContain(language === 'python' ? 'name="Live config"' : "name: 'Live config'")
    expect(preview.error).toBeUndefined()
    expect(preview.source).toBe(Buffer.from(entries[`agent/agent.${extension}`]!).toString())
    expect(preview.source).toContain('./agent/skills')
    expect(preview.source).toContain('./agent/tools/')
    expect(preview.source).toContain('./agent/policies/')
    expect(preview.source).not.toContain(root)
  })

  it.each(['typescript', 'python'] as const)('previews only the exportable authored %s source', async (language) => {
    const root = await temporaryDirectory('strands-live-config-')
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

  it('keeps imported editor paths intact while sanitizing source and error display', async () => {
    const root = join(await temporaryDirectory('strands-live-config-'), 'team\u007fagent')
    mkdirSync(root)
    writeFileSync(join(root, 'agent.ts'), '// \u001b[31mred\u001b[0m\n')
    const project = importAgentProject(root)
    const controller = new ChatController(idleBackend(), {
      configurationSource: () => configurationSource(defineHarnessAgentConfig({}), project),
    })
    try {
      const configuration = controller.getSnapshot().configuration!
      expect(configuration.documents.typescript).toMatchObject({
        source: '// red\n',
        path: project.entrypoint.replace('\u007f', ''),
      })
      expect(configuration.project).toEqual({ root: project.root, entrypoint: project.entrypoint })
      const command = agentProjectEditorCommand(configuration.project!, 'linux', {})
      expect(command.args).toEqual([project.entrypoint])
      expect(existsSync(command.args[0]!)).toBe(true)
      const editor = agentProjectEditorCommand(configuration.project!, 'linux', { EDITOR: 'code' })
      expect(editor.args).toEqual([project.root])
      controller.showError('could not open project', `${configuration.project!.root}\nfailed\u001b[31m`)
      expect(controller.getSnapshot().panel?.rows[0]?.description).toBe(`${project.root.replace('\u007f', '')}\nfailed`)
    } finally {
      await controller.dispose()
    }
  })

  it('reports the same preparation error as export for an unpackaged local module', async () => {
    const root = await temporaryDirectory('strands-live-config-')
    writeFileSync(join(root, 'tool.ts'), 'export const tool = {}\n')
    const profile = defineHarnessAgentConfig({ tools: [{ kind: 'tool', module: './tool.ts' }] })
    const preview = configurationSource(profile, undefined, root).documents.typescript

    expect(preview.error).toContain('files')
    await expect(writeAgentProject(profile, 'typescript', [], join(root, 'agent.zip'), root)).rejects.toThrow(
      preview.error
    )
  })
})
