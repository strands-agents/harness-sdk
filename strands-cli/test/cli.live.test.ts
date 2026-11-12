import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHarness } from '@strands-agents/harness'
import { tool } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { ChatController } from '../src/ui/chat/controller.js'
import { AgentModelRuntime } from '../src/model/runtime.js'
import { ConversationManager } from '../src/ui/chat/conversations.js'
import { StrandsChatBackend } from '../src/agent/backend.js'
import { PythonVoiceSession, type VoiceSupervisorRequest } from '../src/agent/voice.js'

// Requires AWS credentials and a built CLI; runs separately via npm run test:integ.
const run = promisify(execFile)
const BIN = join(process.cwd(), 'dist/src/main.js')
const INTEG_MODEL = process.env.STRANDS_INTEG_MODEL ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0'

interface VoiceObservation {
  type: string
  role?: string
  current_transcript?: string
  is_final?: boolean
  audio_bytes?: number
  pid?: number
  code?: number
}

function readVoiceObservations(path: string): VoiceObservation[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VoiceObservation)
}

describe('strands CLI e2e', () => {
  it(
    'delegates a spoken Bedrock request and speaks the live harness result',
    { timeout: 240_000, retry: 0 },
    async ({ skip }) => {
      try {
        await run('uv', ['--version'])
      } catch (error) {
        if (
          process.env.GITHUB_EVENT_NAME === 'pull_request_target' &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          skip('uv is not installed; live voice integration was not run.')
        }
        throw error
      }
      const cwd = mkdtempSync(join(tmpdir(), 'strands-cli-voice-integ-'))
      const observationsPath = join(cwd, 'voice-events.jsonl')
      const wordPath = join(cwd, 'word.txt')
      const word = 'marigold'
      writeFileSync(wordPath, word)
      const requests: VoiceSupervisorRequest[] = []
      const toolResults: string[] = []
      const states: string[] = []
      const voice = new PythonVoiceSession({
        command: process.execPath,
        args: [
          resolve('scripts/test-voice.mjs'),
          resolve('test/fixtures/voice-sidecar-live.py'),
          '--provider',
          'bedrock',
        ],
        cwd,
        env: { STRANDS_TEST_VOICE_DIRECTORY: cwd },
        startTimeoutMs: 120_000,
        stopTimeoutMs: 10_000,
      })
      voice.onSupervisorRequest((request) => requests.push(request))
      voice.subscribe(() => {
        const { status } = voice.getSnapshot()
        if (states.at(-1) !== status) states.push(status)
      })
      let controller: ChatController | undefined
      let manager: ConversationManager | undefined
      let passed = false
      try {
        const agent = await createHarness({
          name: 'Live voice integration',
          model: INTEG_MODEL,
          effort: 'off',
          builtinTools: [],
          builtinPlugins: [],
          session: false,
          memory: false,
          skills: false,
          caching: false,
          contextManager: false,
          systemPrompt: 'Use read_workspace_word exactly once to read the requested file. Reply with its word briefly.',
          tools: [
            tool({
              name: 'read_workspace_word',
              description: 'Read the word stored in the workspace file.',
              callback: () => {
                const result = readFileSync(wordPath, 'utf8')
                toolResults.push(result)
                return result
              },
            }),
          ],
          printer: false,
          backgroundTasks: false,
        })
        controller = new ChatController(new StrandsChatBackend(new AgentModelRuntime(agent)))
        manager = new ConversationManager(controller, { voice, fork: async () => controller! })
        await manager.submit('/voice on')
        await vi.waitUntil(
          () => {
            const snapshot = voice.getSnapshot()
            if (snapshot.status === 'error') throw new Error(snapshot.message)
            const events = readVoiceObservations(observationsPath)
            return (
              controller!.getSnapshot().completedTurns.length === 1 &&
              events.filter((event) => event.type === 'speech_output_complete').length === 2 &&
              events.some(
                (event) =>
                  event.type === 'transcript' &&
                  event.role === 'assistant' &&
                  event.is_final &&
                  event.current_transcript?.toLowerCase().includes(word)
              )
            )
          },
          { timeout: 90_000, interval: 100 }
        )

        expect(requests.filter((request) => request.action === 'send_instruction')).toHaveLength(1)
        expect(toolResults).toEqual([word])
        const [turn] = controller.getSnapshot().completedTurns
        expect(turn?.status).toBe('complete')
        expect(
          turn?.entries
            .filter((entry) => entry.type === 'assistant')
            .map((entry) => entry.text)
            .join(' ')
        ).toContain(word)
        await manager.submit('/voice off')
        expect(voice.getSnapshot().status).toBe('off')
        const events = readVoiceObservations(observationsPath)
        const replies = events.filter((event) => event.type === 'speech_output_complete')
        expect(replies[0]?.audio_bytes).toBeGreaterThan(0)
        expect(replies[1]?.audio_bytes).toBeGreaterThan(replies[0]!.audio_bytes!)
        expect(events).toContainEqual(expect.objectContaining({ type: 'fixture_input_stopped' }))
        expect(events).toContainEqual(expect.objectContaining({ type: 'fixture_output_stopped' }))
        expect(events).toContainEqual(expect.objectContaining({ type: 'fixture_exit', code: 0 }))
        const pid = events.find((event) => event.type === 'fixture_started')?.pid
        expect(pid).toBeTypeOf('number')
        expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        passed = true
      } finally {
        if (manager) await manager.dispose()
        else await voice.dispose()
        if (passed) rmSync(cwd, { recursive: true, force: true })
        else {
          writeFileSync(
            join(cwd, 'result.json'),
            JSON.stringify({ requests, toolResults, states, snapshot: controller?.getSnapshot() }, null, 2)
          )
          console.error(`Voice integration diagnostics retained at ${cwd}`)
        }
      }
    }
  )

  it('runs a one-shot turn that creates a file via a tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'strands-cli-integ-'))
    // Keep ambient MCP servers out of the live agent's tool set.
    const home = mkdtempSync(join(tmpdir(), 'strands-cli-home-'))
    try {
      await run(
        'node',
        [
          BIN,
          '-p',
          'Use the shell tool to create a file named out.txt in the current directory containing exactly the text: hello. Do nothing else.',
          '--model',
          INTEG_MODEL,
          '--effort',
          'off',
        ],
        {
          cwd,
          timeout: 120_000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
            AWS_SHARED_CREDENTIALS_FILE:
              process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
          },
        }
      )
      const out = join(cwd, 'out.txt')
      expect(existsSync(out)).toBe(true)
      const content = readFileSync(out)
      const encoding = content[0] === 0xff && content[1] === 0xfe ? 'utf16le' : 'utf8'
      expect(content.toString(encoding)).toContain('hello')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
