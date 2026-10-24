import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { Responses, type ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHarness } from '../src/agent.js'
import type { TodoItem } from '../src/plugins/todos.js'

const marker = { mode: 'explicit' }
const projectDoc = 'Offline cache regression project instructions.'

function todos(content: string): TodoItem[] {
  return [{ content, activeForm: content, status: 'in_progress' }]
}

function cachedText(text: string) {
  return { type: 'input_text', text, prompt_cache_breakpoint: marker }
}

function temporaryText(text: string) {
  return { type: 'input_text', text: expect.stringContaining(text) }
}

function userInput(text: string, ...temporary: unknown[]) {
  return { role: 'user', content: [cachedText(text), ...temporary] }
}

// Only the network boundary is replaced. These native Responses events pass through the real
// SDK stream adapter and agent loop, including tool execution and its next model call.
async function* responseStream(id: string, reply: string | TodoItem[]) {
  yield { type: 'response.created', response: { id } }
  if (typeof reply === 'string') {
    yield { type: 'response.output_text.delta', delta: reply }
  } else {
    yield {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'item_todos', call_id: 'call_todos', name: 'todo_write' },
    }
    yield {
      type: 'response.function_call_arguments.done',
      item_id: 'item_todos',
      arguments: JSON.stringify({ todos: reply }),
    }
  }
  yield { type: 'response.completed', response: { id } }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('OpenAI harness prompt caching (offline)', () => {
  // Each turn runs environment probes in the real local sandbox (a PowerShell start per command on Windows),
  // which can exceed the default 5 s on a busy CI runner.
  it(
    'keeps durable checkpoints ahead of changing todos/environment and tool-continuation injections',
    { timeout: 30_000 },
    async () => {
      vi.stubEnv('OPENAI_API_KEY', 'offline-test-key')
      vi.stubEnv('OTEL_TRACES_EXPORTER', 'none')
      // Fail closed if a request ever escapes the responses.create stub.
      const fetch = vi.fn(() => {
        throw new Error('Network access is forbidden in the offline cache regression')
      })
      vi.stubGlobal('fetch', fetch)
      // Environment discovery is memoized, but its date is recomputed on every user turn.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2030, 0, 1, 12))

      const firstTodos = todos('Inspect initial cache prefix')
      const secondTodos = todos('Inspect updated cache prefix')
      const toolTodos = todos('Verify tool continuation')
      const thirdTodos = todos('Review final cache prefix')
      const replies = ['First answer', toolTodos, 'Second answer', 'Third answer']
      const requests: ResponseCreateParamsStreaming[] = []
      const create = vi.spyOn(Responses.prototype, 'create').mockImplementation((request) => {
        const reply = replies[requests.length]
        if (reply === undefined) throw new Error('Unexpected extra OpenAI request')
        requests.push(globalThis.structuredClone(request) as ResponseCreateParamsStreaming)
        // The real client returns an awaitable stream; the adapter only awaits and iterates it.
        return responseStream(`response_${requests.length}`, reply) as unknown as ReturnType<Responses['create']>
      })

      const cwd = process.cwd()
      const dir = mkdtempSync(join(tmpdir(), 'harness-openai-cache-'))
      writeFileSync(join(dir, 'AGENTS.md'), projectDoc)
      process.chdir(dir)
      try {
        const agent = await createHarness({
          model: 'openai/gpt-6-sol',
          systemPrompt: 'Keep this system prompt stable.',
          builtinTools: [],
          builtinPlugins: ['todos', 'environment'],
          memory: false,
          skills: false,
          session: false,
          contextManager: false,
          backgroundTasks: false,
          interventions: 'off',
          printer: false,
        })
        expect(agent.model).toBeInstanceOf(OpenAIModel)
        // Do not pass caching: this also exercises the harness resolver's default opt-in.
        expect(agent.model.getConfig()).toMatchObject({ modelId: 'gpt-6-sol', cacheConfig: { strategy: 'auto' } })

        agent.appState.set('todos', firstTodos)
        await agent.invoke('First question')
        expect(requests).toHaveLength(1)
        expect(requests[0]?.input).toEqual([
          userInput('First question', temporaryText(firstTodos[0]!.content), temporaryText('Date: 2030-01-01')),
        ])
        expect(JSON.stringify(requests[0]?.input)).toContain(projectDoc)
        expect(JSON.stringify(requests[0]?.input)).toContain('Working directory: ')
        const firstHistory = agent.messages.map((message) => message.toJSON())
        expect(firstHistory).toEqual([
          { role: 'user', content: [{ text: 'First question' }], trackingId: expect.any(String) },
          { role: 'assistant', content: [{ text: 'First answer' }], trackingId: expect.any(String) },
        ])

        agent.appState.set('todos', secondTodos)
        vi.setSystemTime(new Date(2030, 0, 2, 12))
        await agent.invoke('Second question')
        expect(requests).toHaveLength(3)
        expect(requests[1]?.input).toEqual([
          userInput('First question'),
          { role: 'assistant', content: 'First answer' },
          userInput('Second question', temporaryText(secondTodos[0]!.content), temporaryText('Date: 2030-01-02')),
        ])
        const toolCall = {
          type: 'function_call',
          call_id: 'call_todos',
          name: 'todo_write',
          arguments: JSON.stringify({ todos: toolTodos }),
        }
        const toolOutput = {
          type: 'function_call_output',
          call_id: 'call_todos',
          output: [cachedText(`1 todos remaining\n  [in_progress] ${toolTodos[0]!.content}`)],
        }
        expect(requests[2]?.input).toEqual([
          userInput('First question'),
          { role: 'assistant', content: 'First answer' },
          userInput('Second question'),
          toolCall,
          toolOutput,
          { role: 'user', content: [temporaryText(toolTodos[0]!.content)] },
        ])
        expect(agent.appState.get('todos')).toEqual(toolTodos)
        // Environment is userTurn-only; the everyTurn todo injector has refreshed after todo_write.
        expect(JSON.stringify(requests[2]?.input)).not.toContain('<environment>')
        for (const request of requests.slice(1)) {
          const input = JSON.stringify(request.input)
          expect(input).not.toContain(firstTodos[0]!.content)
          expect(input).not.toContain('2030-01-01')
        }
        expect(JSON.stringify(requests[2]?.input)).not.toContain(secondTodos[0]!.content)

        agent.appState.set('todos', thirdTodos)
        vi.setSystemTime(new Date(2030, 0, 3, 12))
        await agent.invoke('Third question')
        expect(requests).toHaveLength(4)
        expect(requests[3]?.input).toEqual([
          userInput('First question'),
          { role: 'assistant', content: 'First answer' },
          userInput('Second question'),
          toolCall,
          toolOutput,
          { role: 'assistant', content: 'Second answer' },
          userInput('Third question', temporaryText(thirdTodos[0]!.content), temporaryText('Date: 2030-01-03')),
        ])
        const latestInput = JSON.stringify(requests[3]?.input)
        expect(latestInput).not.toContain(firstTodos[0]!.content)
        expect(latestInput).not.toContain(secondTodos[0]!.content)
        expect(latestInput).not.toContain('2030-01-01')
        expect(latestInput).not.toContain('2030-01-02')

        const history = agent.messages.map((message) => message.toJSON())
        expect(history.slice(0, firstHistory.length)).toEqual(firstHistory)
        expect(history).toHaveLength(8)
        const durableHistory = JSON.stringify(history)
        for (const temporary of ['<system-reminder>', '<environment>', projectDoc, 'prompt_cache_breakpoint']) {
          expect(durableHistory).not.toContain(temporary)
        }
        // The tool's arguments/result are durable; externally seeded todo reminders are not.
        for (const seededTodos of [firstTodos, secondTodos, thirdTodos]) {
          expect(durableHistory).not.toContain(seededTodos[0]!.content)
        }
        for (const request of requests) {
          expect(request).toMatchObject({
            model: 'gpt-6-sol',
            stream: true,
            store: false,
            instructions: 'Keep this system prompt stable.',
            prompt_cache_options: { mode: 'explicit' },
          })
          expect(request).not.toHaveProperty('previous_response_id')
        }
        expect(create).toHaveBeenCalledTimes(4)
        expect(fetch).not.toHaveBeenCalled()
      } finally {
        process.chdir(cwd)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  // With caching on, every OpenAI model gets the per-session routing key; only GPT-5.6+ also gets
  // checkpoints. With caching off, the harness sends no cache fields at all.
  it.each([
    { modelId: 'gpt-6-sol', caching: true },
    { modelId: 'gpt-4.1', caching: true },
    { modelId: 'gpt-6-sol', caching: false },
    { modelId: 'gpt-4.1', caching: false },
  ])('sends the session cache key for $modelId when caching is $caching', async ({ modelId, caching }) => {
    vi.stubEnv('OPENAI_API_KEY', 'offline-test-key')
    vi.stubEnv('OTEL_TRACES_EXPORTER', 'none')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network access is forbidden in the offline cache regression')
      })
    )
    const requests: Record<string, unknown>[] = []
    vi.spyOn(Responses.prototype, 'create').mockImplementation((request) => {
      requests.push(globalThis.structuredClone(request) as unknown as Record<string, unknown>)
      return responseStream('response_1', 'Done') as unknown as ReturnType<Responses['create']>
    })
    const dir = mkdtempSync(join(tmpdir(), 'harness-openai-cache-key-'))
    try {
      const agent = await createHarness({
        model: `openai/${modelId}`,
        caching,
        session: { id: 'cache-key-test', dir },
        builtinTools: [],
        builtinPlugins: [],
        memory: false,
        skills: false,
        contextManager: false,
        backgroundTasks: false,
        interventions: 'off',
        printer: false,
      })
      await agent.invoke('Hello')
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      if (caching) {
        expect(request.prompt_cache_key).toBe('strands-cache-key-test')
        expect('prompt_cache_options' in request).toBe(modelId === 'gpt-6-sol')
      } else {
        expect(request).not.toHaveProperty('prompt_cache_key')
        expect(request).not.toHaveProperty('prompt_cache_options')
        expect(JSON.stringify(request.input)).not.toContain('prompt_cache_breakpoint')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
