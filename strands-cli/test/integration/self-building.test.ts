import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { unzipSync } from 'fflate'
import { expect, it } from 'vitest'

import type { ChatConfigurationSource, ChatSnapshot } from '../../src/tui/chat/types.js'
import { CliConfigStore, PROVIDER_IDS } from '../../src/tui/config.js'
import { pythonExecutable } from '../fixtures/python-runtime.js'
import { expectRestoredTerminal, runTuiCommand } from '../tui-integration/harness.js'
import { E2E_CASE } from './catalog.js'

const model = process.env.STRANDS_INTEG_MODEL ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0'
const bin = resolve('dist/src/main.js')
const fixture = (name: string): string => resolve(import.meta.dirname, '../fixtures', name)
const setupPrompt =
  'Add the existing local stdio MCP server ./probe-server.mjs to yourself as "lifecycle". ' +
  'It runs with command "node", args ["./probe-server.mjs"], and files ["./probe-server.mjs"] so it exports portably. ' +
  'Set its env to {"STRANDS_CLI_TEST_MCP_AUDIT":"${env:STRANDS_CLI_TEST_MCP_AUDIT}"} to record tool receipts. ' +
  'Use strands_config to inspect, update mcpServers, and apply the latest revision now. Preserve all other settings. ' +
  'Do not edit the server or run it through shell. End this turn after applying; I will ask you to use it next.'

interface Observation {
  snapshot: ChatSnapshot
  configuration: ChatConfigurationSource
}

interface Receipt {
  challenge: string
  receipt: string
  server: string
  pid: number
}

for (const [language, scenario] of [
  ['typescript', E2E_CASE.selfBuildingTypescript],
  ['python', E2E_CASE.selfBuildingPython],
] as const) {
  it(scenario.testName, { timeout: 900_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'strands-live-self-building-'))
    const audit = join(root, 'mcp-calls.jsonl')
    let archive: string | undefined
    try {
      const pythonPath =
        language === 'python' && (process.env.STRANDS_TEST_PYTHON || existsSync(pythonExecutable))
          ? { PATH: [dirname(pythonExecutable), process.env.PATH].filter(Boolean).join(delimiter) }
          : {}
      if (language === 'python') {
        execFileSync(
          process.platform === 'win32' ? 'python' : 'python3',
          ['-c', 'import sys; assert sys.version_info >= (3, 10), "Set STRANDS_TEST_PYTHON to Python 3.10 or newer"'],
          { env: { ...process.env, ...pythonPath }, timeout: 10_000 }
        )
      }
      for (let round = 0; round < 3; round++) {
        const cwd = join(root, `workspace-${round}`)
        const home = join(root, `home-${round}`)
        await mkdir(cwd)
        await mkdir(home)
        const config = await CliConfigStore.load(join(home, '.strands', 'cli.toml'))
        await config.saveSetup({
          providers: [PROVIDER_IDS.find((provider) => model.startsWith(`${provider}/`)) ?? 'bedrock'],
          profile: defineHarnessAgentConfig({ model, effort: 'off', memory: false, session: false, skills: false }),
          profileBaseDir: cwd,
          permissionMode: 'bypassPermissions',
          providerEnvironment: {},
          settings: { animations: false, agentMessaging: false, mcpDiscovery: false, skillDiscovery: false },
        })
        expect(config.snapshot().profile.mcpServers).toEqual({})
        if (round === 0) {
          await copyFile(fixture('live-self-building-mcp.mjs'), join(cwd, 'probe-server.mjs'))
        }
        const challenge = randomUUID()
        const statePath = join(root, `state-${round}.json`)
        const nextArchive = join(root, `export-${round}.zip`)
        const result = await runTuiCommand({
          scenario: 'live-self-building',
          command: [
            process.execPath,
            '--import',
            fixture('live-self-building-observer.mjs'),
            bin,
            ...(archive ? ['--agent', archive] : []),
          ],
          cwd,
          exportPath: nextArchive,
          exportLanguage: language,
          timeout: 420_000,
          env: {
            ...pythonPath,
            HOME: home,
            USERPROFILE: home,
            // Keep provider authentication available while isolating CLI configuration and discovery.
            AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
            AWS_SHARED_CREDENTIALS_FILE:
              process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
            STRANDS_CLI_TELEMETRY: 'off',
            STRANDS_CLI_TEST_STATE_PATH: statePath,
            STRANDS_CLI_TEST_MCP_AUDIT: audit,
            ...(round === 0 ? { STRANDS_CLI_TEST_SETUP_PROMPT: setupPrompt } : {}),
            STRANDS_CLI_TEST_USE_PROMPT:
              `Call the lifecycle_probe MCP tool with challenge "${challenge}" exactly once. ` +
              'Return its receipt verbatim. Use the connected MCP tool; do not use shell or edit any files.',
          },
        })
        await writeFile(join(root, `terminal-${round}.log`), result.output)
        expect(result.returnCode).toBe(0)
        expect(result.exportSaved).toBe(true)
        expectRestoredTerminal(result)

        const { snapshot, configuration } = JSON.parse(await readFile(statePath, 'utf8')) as Observation
        expect(snapshot.completedTurns).toHaveLength(round === 0 ? 2 : 1)
        expect(snapshot.completedTurns.every((turn) => turn.status === 'complete')).toBe(true)
        const tools = snapshot.completedTurns.flatMap((turn) => turn.entries).filter((entry) => entry.type === 'tool')
        expect(
          tools.filter(
            (entry) =>
              (entry.name === 'strands_config' || entry.name.endsWith('lifecycle_probe')) && entry.status !== 'success'
          )
        ).toEqual([])
        if (round === 0) {
          const changes = tools.filter((entry) => entry.name === 'strands_config' && entry.status === 'success')
          expect(changes.map((entry) => entry.input)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ action: 'update' }),
              expect.objectContaining({ action: 'apply' }),
            ])
          )
        }
        const calls = (await readFile(audit, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Receipt)
        const receipts = calls.filter((call) => call.challenge === challenge)
        expect(receipts).toHaveLength(1)
        const receipt = receipts[0]!
        expect(
          tools.some(
            (entry) =>
              entry.name.endsWith('lifecycle_probe') &&
              entry.status === 'success' &&
              JSON.stringify(entry.result).includes(receipt.receipt)
          )
        ).toBe(true)
        if (round > 0) expect(receipt.server).toContain(`${pathToFileURL(await realpath(home)).href}/`)

        const document = configuration.documents[language]
        expect(document.error).toBeUndefined()
        expect(document.generated).toBe(round === 0)
        const files = unzipSync(await readFile(nextArchive))
        expect(Buffer.from(files[`agent/agent.${language === 'typescript' ? 'ts' : 'py'}`]!).toString()).toBe(
          document.source
        )
        expect(document.source).toContain('lifecycle')
        expect(document.source).not.toContain(root)
        const servers = Object.keys(files).filter((name) => name.endsWith('probe-server.mjs'))
        expect(servers).toHaveLength(1)
        expect(Buffer.from(files[servers[0]!]!)).toEqual(await readFile(fixture('live-self-building-mcp.mjs')))
        if (round === 0) await rm(cwd, { recursive: true, force: true })
        archive = nextArchive
      }
    } catch (error) {
      await writeFile(join(root, 'failure.log'), String(error))
      throw new Error(`Self-building lifecycle failed; diagnostics retained in ${root}`, { cause: error })
    }
    await rm(root, { recursive: true, force: true })
  })
}
