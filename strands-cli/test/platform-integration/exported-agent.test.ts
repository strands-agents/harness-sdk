import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig, type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CliConfigStore } from '../../src/tui/config.js'
import { writeAgentProject } from '../../src/tui/project/export.js'
import {
  importAgentProject,
  type AgentProjectLanguage,
  type ImportedAgentProject,
} from '../../src/tui/project/import.js'
import { resolveSkillPaths } from '../../src/tui/skills.js'
import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { pythonEnvironment, pythonExecutable } from '../fixtures/python-runtime.js'
import { expectRestoredTerminal, runTuiCommand } from '../tui-integration/harness.js'
import { PLATFORM_CASE } from './catalog.js'

const run = promisify(execFile)
const bin = join(process.cwd(), 'dist', 'src', 'main.js')
let root: string
let archive: string
let home: string
let pythonArchive: string
let pythonStubs: string
let profile: HarnessAgentConfig
let setupHome: string

describe('cross-platform exported agent E2E', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-platform-integration-'))
    home = join(root, 'home')
    setupHome = join(root, 'setup-home')
    pythonStubs = join(root, 'python-stubs')
    await Promise.all([mkdir(home), mkdir(setupHome), mkdir(pythonStubs)])
    await copyFile(
      resolve(import.meta.dirname, '..', 'fixtures', 'platform-integration-sitecustomize.py'),
      join(pythonStubs, 'sitecustomize.py')
    )
    profile = await createPlatformProfile('https://skills.example.test/SKILL.md', 'typescript')
    archive = await exportProfile(profile, 'platform-agent.zip')
    const exportedPythonProfile = await createPlatformProfile('https://skills.example.test/SKILL.md', 'python')
    pythonArchive = await exportProfile(exportedPythonProfile, 'platform-python-agent.zip', 'python')
    const config = await CliConfigStore.load(join(home, '.strands', 'cli', 'config.json'))
    await config.saveSetup({
      providers: ['bedrock'],
      profile,
      profileBaseDir: root,
      permissionMode: 'bypassPermissions',
      providerEnvironment: {},
      settings: { animations: false, agentMessaging: false, mcpDiscovery: false, skillDiscovery: false },
    })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(PLATFORM_CASE.lifecycle.testName, async () => {
    const firstArchive = join(root, 'lifecycle-first.zip')
    const first = await runTuiCommand({
      scenario: 'lifecycle-profile',
      command: [process.execPath, bin],
      cwd: root,
      exportPath: firstArchive,
      env: cliEnvironment(),
      timeout: 40_000,
    })
    const firstOutput = sanitizeTerminalText(first.output)
    expect(first.returnCode).toBe(0)
    expect(firstOutput).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(first.exportSaved).toBe(true)
    expectRestoredTerminal(first)

    const secondArchive = join(root, 'lifecycle-second.zip')
    const second = await runTuiCommand({
      scenario: 'lifecycle-project',
      command: [process.execPath, bin, '--agent', firstArchive],
      cwd: root,
      exportPath: secondArchive,
      env: cliEnvironment(),
      timeout: 40_000,
    })
    const secondOutput = sanitizeTerminalText(second.output)
    expect(second.returnCode).toBe(0)
    expect(secondOutput).toContain('platform-mcp-ok')
    expectMcpStopped(secondOutput)
    expect(second.exportSaved).toBe(true)
    expectRestoredTerminal(second)

    const finalOutput = await cliFor(secondArchive, 'invoke the MCP probe after re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it.skipIf(!existsSync(pythonExecutable))(PLATFORM_CASE.pythonLifecycle.testName, async () => {
    await preparePythonArchive(pythonArchive)
    const secondArchive = join(root, 'lifecycle-python-second.zip')
    const result = await runTuiCommand({
      scenario: 'lifecycle-project',
      command: [process.execPath, bin, '--agent', pythonArchive],
      cwd: root,
      exportPath: secondArchive,
      exportLanguage: 'python',
      env: cliEnvironment(),
      timeout: 60_000,
    })
    const output = sanitizeTerminalText(result.output)
    expect(result.returnCode).toBe(0)
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
    expect(result.exportSaved).toBe(true)
    expectRestoredTerminal(result)

    await preparePythonArchive(secondArchive)
    const finalOutput = await cliFor(secondArchive, 'invoke the MCP probe after re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it(PLATFORM_CASE.setupImport.testName, async () => {
    const exported = join(root, 'setup-imported-agent.zip')
    const result = await runTuiCommand({
      scenario: 'lifecycle-setup-import',
      command: [process.execPath, bin, '--setup'],
      cwd: root,
      exportPath: exported,
      importPath: archive,
      env: cliEnvironment(setupHome),
      timeout: 60_000,
    })
    const output = sanitizeTerminalText(result.output)
    expect(result.returnCode).toBe(0)
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
    expect(result.exportSaved).toBe(true)
    expectRestoredTerminal(result)

    const setupConfig = await CliConfigStore.load(join(setupHome, '.strands', 'cli', 'config.json'))
    expect(setupConfig.snapshot().agentProject).toMatch(/agent[/\\]agent\.ts$/u)
    const finalOutput = await cliFor(exported, 'invoke the MCP probe after setup re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it(PLATFORM_CASE.failures.testName, async () => {
    const parentFile = join(root, 'not-a-directory')
    await writeFile(parentFile, 'occupied')
    const invalidDestination = join(parentFile, 'agent.zip')
    const save = await runTuiCommand({
      scenario: 'export-failure',
      command: [process.execPath, bin],
      cwd: root,
      exportPath: invalidDestination,
      env: cliEnvironment(),
    })
    expect(save.returnCode).toBe(0)
    expect(save.exportSaved).toBe(false)
    expect(sanitizeTerminalText(save.output)).toContain('file already exists')
    expectRestoredTerminal(save)

    const corrupt = join(root, 'corrupt-agent.zip')
    await writeFile(corrupt, 'not a ZIP')
    const cacheBefore = await cachedAgentEntries()
    const failure = await cliFailure(corrupt)
    expect(failure.code).not.toBe(0)
    expect(failure.output).toMatch(/invalid zip|central directory/iu)
    expect(await cachedAgentEntries()).toEqual(cacheBefore)
  })

  it(PLATFORM_CASE.exportedAgent.testName, async () => {
    const output = await cli('report capabilities')
    expect(output).toContain('HISTORY=report capabilities')
  })

  it(PLATFORM_CASE.skills.testName, async () => {
    const output = await cli('report capabilities')
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
  })

  it(PLATFORM_CASE.mcp.testName, async () => {
    const output = await cli('invoke the MCP probe')
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
  })

  it(PLATFORM_CASE.session.testName, async () => {
    await cli('remember platform-alpha', '--session-id', 'platform-resume')
    const output = await cli('recall platform-beta', '--session-id', 'platform-resume')
    expect(output).toContain('HISTORY=remember platform-alpha|recall platform-beta')
  })
})

async function createPlatformProfile(skillUrl: string, language: AgentProjectLanguage): Promise<HarnessAgentConfig> {
  const modelFile = `platform-integration-model.${language === 'python' ? 'py' : 'ts'}`
  const model = await fixture(modelFile)
  const mcpServer = await fixture('platform-integration-mcp.mjs')
  const localSkill = join(root, 'skills', 'local')
  await mkdir(localSkill, { recursive: true })
  await writeFile(
    join(localSkill, 'SKILL.md'),
    '---\nname: local-platform-skill\ndescription: Local platform integration marker.\n---\nUse local-platform-skill.\n'
  )
  await writeFile(join(root, modelFile), model)
  await writeFile(join(root, 'platform-integration-mcp.mjs'), mcpServer)
  const modelReference: HarnessModuleReference = {
    kind: 'model',
    module: `./${modelFile}`,
    export: 'model',
    language,
    files: [`./${modelFile}`],
  }
  const skills = [skillUrl, './skills']
  return defineHarnessAgentConfig({
    name: `Platform ${language} integration agent`,
    model: 'fixture/platform-integration',
    modelModule: modelReference,
    builtinTools: [],
    builtinPlugins: [],
    mcpServers: {
      platform: {
        command: 'node',
        args: ['./platform-integration-mcp.mjs'],
        files: ['./platform-integration-mcp.mjs'],
      },
    },
    memory: false,
    session: language === 'typescript' ? { dir: './state/sessions' } : false,
    skills,
  })
}

async function exportProfile(
  profile: HarnessAgentConfig,
  name: string,
  language: AgentProjectLanguage = 'typescript'
): Promise<string> {
  const skills = Array.isArray(profile.skills) ? profile.skills : []
  const destination = join(root, name)
  await writeAgentProject(profile, language, resolveSkillPaths(skills, root, false), destination, root)
  return destination
}

async function cliFor(agent: string, prompt: string, ...args: string[]): Promise<string> {
  const result = await run(process.execPath, [bin, '--agent', agent, '--print', prompt, ...args], {
    cwd: root,
    timeout: 30_000,
    env: { ...process.env, ...cliEnvironment() },
  })
  return `${result.stdout}\n${result.stderr}`
}

function cliEnvironment(targetHome = home): NodeJS.ProcessEnv {
  return {
    AWS_EC2_METADATA_DISABLED: 'true',
    HOME: targetHome,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${
      pathToFileURL(resolve(import.meta.dirname, '..', 'fixtures', 'platform-integration-fetch.mjs')).href
    }`.trim(),
    PYTHONPYCACHEPREFIX: join(targetHome, 'python-cache'),
    PYTHONPATH: [
      pythonStubs,
      resolve(process.cwd(), '..', 'harness-py', 'src'),
      resolve(process.cwd(), '..', 'strands-py', 'src'),
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(delimiter),
    USERPROFILE: targetHome,
  }
}

function expectMcpStopped(output: string): void {
  const pid = Number(output.match(/"pid":(\d+)/u)?.[1])
  expect(pid).toBeGreaterThan(0)
  expect(processRunning(pid)).toBe(false)
}

async function cli(prompt: string, ...args: string[]): Promise<string> {
  return cliFor(archive, prompt, ...args)
}

async function fixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, '..', 'fixtures', name), 'utf8')
}

async function preparePythonArchive(path: string): Promise<void> {
  const previous = { home: process.env.HOME, userProfile: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  let project: ImportedAgentProject
  try {
    project = importAgentProject(path)
  } finally {
    if (previous.home === undefined) delete process.env.HOME
    else process.env.HOME = previous.home
    if (previous.userProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.userProfile
  }
  const environment = join(project.root, '.venv')
  await rm(environment, { recursive: true, force: true })
  await symlink(pythonEnvironment, environment, 'junction')
  const manifests = await Promise.all(
    ['requirements.txt', 'pyproject.toml', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'].map(
      async (name) => {
        try {
          return await readFile(join(project.root, name), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }
    )
  )
  const fingerprint = createHash('sha256').update(JSON.stringify(manifests)).digest('hex')
  await writeFile(join(project.root, '.strands-dependencies'), fingerprint)
}

async function cachedAgentEntries(): Promise<string[]> {
  try {
    return (await readdir(join(home, '.strands', 'cli', 'cache', 'agents'))).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function cliFailure(agent: string): Promise<{ code: number | string; output: string }> {
  try {
    await run(process.execPath, [bin, '--agent', agent, '--print', 'unused'], {
      cwd: root,
      timeout: 30_000,
      env: { ...process.env, ...cliEnvironment() },
    })
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string; stdout?: string }
    if (failure.code !== undefined) {
      return { code: failure.code, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` }
    }
    throw error
  }
  throw new Error('Expected the CLI to reject the corrupt archive.')
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
