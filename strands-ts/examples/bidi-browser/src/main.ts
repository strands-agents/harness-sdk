import { tool } from '@strands-agents/sdk'
import type { Sandbox, ToolContext } from '@strands-agents/sdk'
import { BedrockNovaSonicModel, BidiAgent, OpenAIRealtimeModel } from '@strands-agents/sdk/bidi'
import type { BidiModel, BidiOutputEvent } from '@strands-agents/sdk/bidi'
import { BrowserAudioIO } from '@strands-agents/sdk/bidi/io/browser-audio'
import { BrowserSandbox } from '@strands-agents/sdk/sandbox/browser'
import { z } from 'zod'

// --- DOM ---------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const providerSelect = $<HTMLSelectElement>('provider')
const startButton = $<HTMLButtonElement>('start')
const stopButton = $<HTMLButtonElement>('stop')
const statusLabel = $('status')
const log = $('log')
const value = (id: string): string => $<HTMLInputElement>(id).value.trim()

function append(className: string, text: string): void {
  const line = document.createElement('div')
  line.className = className
  line.textContent = text
  log.append(line)
  log.scrollTop = log.scrollHeight
}

providerSelect.addEventListener('change', () => {
  for (const section of document.querySelectorAll<HTMLElement>('[data-provider]')) {
    section.hidden = section.dataset.provider !== providerSelect.value
  }
})

// --- Sandbox: private browser storage by default, or a folder the user picks -------------------

let sandbox = new BrowserSandbox()
const pickFolder = $<HTMLButtonElement>('pick-folder')
const showDirectoryPicker = (
  window as unknown as { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle> }
).showDirectoryPicker

if (showDirectoryPicker) {
  pickFolder.addEventListener('click', async () => {
    const folder = await showDirectoryPicker({ mode: 'readwrite' })
    sandbox = new BrowserSandbox({ root: folder })
    $('storage').textContent = `Local folder: ${folder.name}`
  })
} else {
  pickFolder.hidden = true // File System Access API is Chromium-only
}

// --- Tools -------------------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getTime = tool({
  name: 'get_time',
  description: 'Get the current date and time, optionally in an IANA timezone such as "Asia/Tokyo".',
  inputSchema: z.object({ timezone: z.string().optional() }),
  callback: ({ timezone }) =>
    new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }),
})

const rollDice = tool({
  name: 'roll_dice',
  description: 'Roll one or more dice.',
  inputSchema: z.object({ count: z.number().int().min(1).max(10).default(1), sides: z.number().int().min(2).default(6) }),
  callback: ({ count, sides }) => {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) }
  },
})

// The note and code tools go through agent.sandbox, so they work the same against OPFS or a local folder.
const sandboxOf = (context: ToolContext | undefined): Sandbox => {
  if (!context) throw new Error('tool called without an agent context')
  return context.agent.sandbox
}

const saveNote = tool({
  name: 'save_note',
  description: 'Save a short text note under a name.',
  inputSchema: z.object({ name: z.string(), text: z.string() }),
  callback: async ({ name, text }, context) => {
    await sandboxOf(context).writeFile(`notes/${name}.txt`, encoder.encode(text))
    return `Saved note "${name}".`
  },
})

const readNote = tool({
  name: 'read_note',
  description: 'Read a saved note by name.',
  inputSchema: z.object({ name: z.string() }),
  callback: async ({ name }, context) => decoder.decode(await sandboxOf(context).readFile(`notes/${name}.txt`)),
})

const listNotes = tool({
  name: 'list_notes',
  description: 'List the names of saved notes.',
  inputSchema: z.object({}),
  callback: async (_input, context) => {
    try {
      const files = await sandboxOf(context).listFiles('notes')
      return files.filter((file) => !file.isDir).map((file) => file.name.replace(/\.txt$/, ''))
    } catch {
      return []
    }
  },
})

const runJavaScript = tool({
  name: 'run_javascript',
  description: 'Run JavaScript in an isolated worker and return what it prints with console.log.',
  inputSchema: z.object({ code: z.string() }),
  callback: async ({ code }, context) => {
    const { exitCode, stdout, stderr } = await sandboxOf(context).executeCode(code, 'javascript', { timeout: 5 })
    return { exitCode, stdout, stderr }
  },
})

// --- Model -------------------------------------------------------------------------------------

async function createModel(): Promise<BidiModel> {
  switch (providerSelect.value) {
    case 'openai':
      return new OpenAIRealtimeModel({
        modelId: 'gpt-realtime',
        transcriptionModelId: 'gpt-4o-transcribe',
        apiKey: value('openai-key'),
      })
    case 'gemini': {
      // Loaded on demand so the other providers never download @google/genai.
      const { GoogleGeminiLiveModel } = await import('@strands-agents/sdk/bidi/models/google')
      return new GoogleGeminiLiveModel({ modelId: 'gemini-live-2.5-flash-preview', apiKey: value('gemini-key') })
    }
    default: {
      const sessionToken = value('aws-session-token')
      return new BedrockNovaSonicModel({
        region: value('aws-region'),
        clientConfig: {
          credentials: {
            accessKeyId: value('aws-access-key-id'),
            secretAccessKey: value('aws-secret-access-key'),
            ...(sessionToken ? { sessionToken } : {}),
          },
        },
      })
    }
  }
}

// --- Run ---------------------------------------------------------------------------------------

function render(event: BidiOutputEvent): void {
  switch (event.type) {
    case 'bidiConnectionStart':
      statusLabel.textContent = 'Listening — speak now'
      break
    case 'bidiTranscriptBlock':
      append(event.role, `${event.role === 'user' ? 'You' : 'Agent'}: ${event.transcript}`)
      break
    case 'bidiTextBlock':
      append('assistant', `Agent: ${event.text}`)
      break
    case 'bidiToolUseBlocks':
      for (const toolUse of event.toolUses) append('tool', `→ ${toolUse.name}(${JSON.stringify(toolUse.input)})`)
      break
  }
}

let running: AbortController | undefined

// Started from a click so the browser allows microphone access and audio playback.
startButton.addEventListener('click', async () => {
  startButton.disabled = true
  stopButton.disabled = false
  statusLabel.textContent = 'Connecting…'
  running = new AbortController()

  try {
    const agent = new BidiAgent({
      model: await createModel(),
      tools: [getTime, rollDice, saveNote, readNote, listNotes, runJavaScript],
      systemPrompt: 'You are a friendly voice assistant. Keep replies to one or two short sentences.',
      sandbox,
    })
    const audio = new BrowserAudioIO()
    await agent.run({ inputs: [audio.input()], outputs: [audio.output(), render], cancelSignal: running.signal })
  } catch (error) {
    if (!running.signal.aborted) append('error', `Error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    running = undefined
    startButton.disabled = false
    stopButton.disabled = true
    statusLabel.textContent = 'Idle'
  }
})

stopButton.addEventListener('click', () => running?.abort())
