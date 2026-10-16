/**
 * Bidi playground: a Nova Sonic agent with tools, hooks, and live usage stats.
 *
 *   npm start            # text mode: type in the terminal, read the reply transcripts
 *   npm start -- voice   # voice mode: talk into your mic, hear the replies (needs audify + mic access)
 *
 * Ctrl+C ends the session and prints a summary. Hook activity is written to bidi-playground.log
 * (writing to stdout would fight with ConsoleIO's live-redrawn input line).
 */
import { appendFileSync, writeFileSync } from 'node:fs'

import { tool } from '@strands-agents/sdk'
import {
  AudioDelta,
  BedrockNovaSonicModel,
  BidiAgent,
  type BidiAgentInput,
  type BidiOutputEvent,
  type BidiRunInput,
  type BidiRunOutput,
} from '@strands-agents/sdk/bidi'
import { ConsoleIO } from '@strands-agents/sdk/bidi/io/console'
import {
  BidiAfterConnectionRestartEvent,
  BidiBargeInEvent,
  BidiResponseStopEvent,
} from '@strands-agents/sdk/bidi/hooks'
import { z } from 'zod'

const mode = process.argv[2] === 'voice' ? 'voice' : 'text'
const region = process.env.AWS_REGION ?? 'us-east-1'
const modelId = process.env.NOVA_MODEL_ID ?? 'amazon.nova-2-5-sonic'
const LOG_FILE = 'bidi-playground.log'

// --- Tools -------------------------------------------------------------------------------------

const getTime = tool({
  name: 'get_time',
  description: 'Get the current date and time, optionally in a specific IANA timezone.',
  inputSchema: z.object({
    timezone: z.string().optional().describe('IANA timezone, e.g. "Europe/Istanbul". Defaults to local time.'),
  }),
  callback: ({ timezone }) =>
    new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }),
})

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City name, e.g. "Seattle"') }),
  callback: ({ city }) => {
    // Fake but deterministic, so you can tell the tool actually ran.
    const temp = 50 + ([...city].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 40)
    return { city, temperatureF: temp, conditions: temp > 75 ? 'sunny' : 'cloudy' }
  },
})

const rollDice = tool({
  name: 'roll_dice',
  description: 'Roll one or more dice with a given number of sides.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(10).default(1),
    sides: z.number().int().min(2).max(100).default(6),
  }),
  callback: ({ count, sides }) => {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) }
  },
})

// --- Agent + hooks -----------------------------------------------------------------------------

const agent = new BidiAgent({
  model: new BedrockNovaSonicModel({ modelId, region }),
  tools: [getTime, getWeather, rollDice],
  systemPrompt:
    'You are a friendly voice assistant. Keep replies to one or two short sentences. ' +
    'Use your tools for the time, the weather, and dice rolls.',
})

const stats = { responses: 0, bargeIns: 0, restarts: 0, toolCalls: [] as string[], inputTokens: 0, outputTokens: 0 }
const log = (line: string): void => appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
writeFileSync(LOG_FILE, '')

agent.addHook(BidiResponseStopEvent, (event) => {
  stats.responses++
  log(`response stopped id=${event.responseId}`)
})
agent.addHook(BidiBargeInEvent, () => {
  stats.bargeIns++
  log('user barged in (interrupted the model)')
})
agent.addHook(BidiAfterConnectionRestartEvent, (event) => {
  stats.restarts++
  log(`connection restarted reason=${event.reason}${event.error ? ` error=${event.error.message}` : ''}`)
})

// A plain callback works as an output too, alongside the IO streams.
const statsOutput: BidiRunOutput = (event: BidiOutputEvent) => {
  if (event.type === 'bidiUsage') {
    // Nova reports running totals per direction; some events carry only one side, so keep the max.
    stats.inputTokens = Math.max(stats.inputTokens, event.inputTokens)
    stats.outputTokens = Math.max(stats.outputTokens, event.outputTokens)
  } else if (event.type === 'bidiToolUseBlocks') {
    for (const block of event.toolUses) {
      stats.toolCalls.push(block.name)
      log(`tool call ${block.name} ${JSON.stringify(block.input)}`)
    }
  }
}

/**
 * Nova Sonic only starts answering once an audio input stream is open, so in text mode we
 * stream silence next to the keyboard. An async iterable is a valid input on its own.
 */
async function* silence(signal: AbortSignal): AsyncGenerator<BidiAgentInput> {
  const chunkMs = 32
  const bytes = new Uint8Array((16000 * 2 * chunkMs) / 1000) // 16 kHz, 16-bit mono PCM
  while (!signal.aborted) {
    yield new AudioDelta({ format: 'pcm', source: { bytes } })
    await new Promise((resolve) => setTimeout(resolve, chunkMs))
  }
}

// --- Run ---------------------------------------------------------------------------------------

const cancel = new AbortController()
process.once('SIGINT', () => cancel.abort())

let inputs: BidiRunInput[]
let outputs: BidiRunOutput[]

if (mode === 'voice') {
  // Imported lazily so text mode works without the native audify dependency.
  const { AudioIO } = await import('@strands-agents/sdk/bidi/io/audio')
  // AudioIO's output also renders transcripts and tool calls in the terminal.
  const audio = new AudioIO()
  inputs = [audio.input()]
  outputs = [audio.output(), statsOutput]
  console.log(`🎙  voice mode (${modelId} in ${region}) — start talking. Ctrl+C to quit.\n`)
} else {
  const io = new ConsoleIO({ placeholder: 'Try: "what time is it in Tokyo?" or "roll two dice"' })
  inputs = [io.input(), silence(cancel.signal)]
  outputs = [io.output(), statsOutput]
  console.log(`⌨️  text mode (${modelId} in ${region}). Ctrl+C to quit.\n`)
}

let exitCode = 0
try {
  await agent.run({ inputs, outputs, cancelSignal: cancel.signal })
} catch (error) {
  if (!cancel.signal.aborted) {
    console.error('\nsession failed:', error)
    exitCode = 1
  }
} finally {
  console.log('\n--- session summary ---')
  console.log(`responses:   ${stats.responses}`)
  console.log(`tool calls:  ${stats.toolCalls.length ? stats.toolCalls.join(', ') : 'none'}`)
  console.log(`barge-ins:   ${stats.bargeIns}`)
  console.log(`restarts:    ${stats.restarts}`)
  console.log(`tokens:      ${stats.inputTokens} in / ${stats.outputTokens} out`)
  console.log(`messages:    ${agent.messages.length} in history`)
  console.log(`hook log:    ${LOG_FILE}`)
  process.exit(exitCode)
}
