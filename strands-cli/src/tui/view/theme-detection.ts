import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import type { ResolvedColorMode } from '../chat/types.js'

const BACKGROUND_QUERY = '\u001b]11;?\u001b\\'
const BACKGROUND_RESPONSE_PREFIX = '\u001b]11;'
const BACKGROUND_VALUE = /^(?:rgb|rgba):([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})(?:\/[\da-f]{1,4})?$/iu
const COLOR_SCHEME_REPORT_PREFIX = '\u001b[?997;'
const COLOR_SCHEME_NOTIFICATIONS = { enable: '\u001b[?2031h', disable: '\u001b[?2031l' } as const
const THEME_RESPONSE = new RegExp(String.raw`\x1b\[\?997;[12]n|\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)`, 'giu')
const QUERY_TIMEOUT_MS = 100
let detectedMode: ResolvedColorMode = 'dark'
const modeListeners = new Set<() => void>()

export function currentColorMode(): ResolvedColorMode {
  return detectedMode
}

export function subscribeColorMode(listener: () => void): () => void {
  modeListeners.add(listener)
  return () => modeListeners.delete(listener)
}

export function observeTerminalColorMode(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  timeoutMs = QUERY_TIMEOUT_MS
): { input: NodeJS.ReadStream; ready: Promise<void>; dispose(): void } {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    setColorMode('dark')
    return { input, ready: Promise.resolve(), dispose: (): void => {} }
  }

  let resolveReady!: () => void
  let ready = false
  const initialMode = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const finishInitialQuery = (): void => {
    if (ready) return
    ready = true
    clearTimeout(queryTimer)
    resolveReady()
  }
  const queryTimer = setTimeout(() => {
    setColorMode('dark')
    finishInitialQuery()
  }, timeoutMs)

  const decoder = new StringDecoder('utf8')
  let pending = ''
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  const filtered = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      if (pendingTimer) clearTimeout(pendingTimer)
      const result = readThemeResponses(pending + decoder.write(chunk), {
        background: (value) => {
          const mode = parseBackgroundMode(value)
          if (mode) {
            setColorMode(mode)
            finishInitialQuery()
          }
        },
        changed: () => output.write(BACKGROUND_QUERY),
      })
      pending = result.pending
      if (pending) {
        pendingTimer = setTimeout(
          () => {
            filtered.push(pending)
            pending = ''
          },
          pending.startsWith(BACKGROUND_RESPONSE_PREFIX) || pending.startsWith(COLOR_SCHEME_REPORT_PREFIX)
            ? timeoutMs
            : 10
        )
      }
      callback(undefined, result.output)
    },
    flush(callback): void {
      if (pendingTimer) clearTimeout(pendingTimer)
      callback(undefined, pending + decoder.end())
    },
  }) as Transform & NodeJS.ReadStream

  Object.defineProperties(filtered, {
    isTTY: { value: true },
    isRaw: { get: () => input.isRaw },
  })
  filtered.setRawMode = (mode): typeof filtered => {
    input.setRawMode(mode)
    return filtered
  }
  filtered.ref = (): typeof filtered => {
    input.ref()
    return filtered
  }
  filtered.unref = (): typeof filtered => {
    input.unref()
    return filtered
  }

  const wasRaw = input.isRaw === true
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearTimeout(queryTimer)
    if (pendingTimer) clearTimeout(pendingTimer)
    input.unpipe(filtered)
    filtered.destroy()
    output.write(COLOR_SCHEME_NOTIFICATIONS.disable)
    if (!wasRaw && input.isRaw) input.setRawMode(false)
    finishInitialQuery()
  }

  try {
    input.setRawMode(true)
    input.pipe(filtered)
    output.write(`${COLOR_SCHEME_NOTIFICATIONS.enable}${BACKGROUND_QUERY}`)
  } catch {
    dispose()
    setColorMode('dark')
    return { input, ready: initialMode, dispose: (): void => {} }
  }
  return { input: filtered, ready: initialMode, dispose }
}

function readThemeResponses(
  value: string,
  onResponse: { background(value: string): void; changed(): void }
): { output: string; pending: string } {
  const output = value.replace(THEME_RESPONSE, (response) => {
    if (response.startsWith(BACKGROUND_RESPONSE_PREFIX)) {
      onResponse.background(response)
    } else {
      onResponse.changed()
    }
    return ''
  })
  const pendingStart = incompleteResponseStart(output)
  return pendingStart < 0
    ? { output, pending: '' }
    : { output: output.slice(0, pendingStart), pending: output.slice(pendingStart) }
}

function incompleteResponseStart(value: string): number {
  const started = Math.max(value.lastIndexOf(BACKGROUND_RESPONSE_PREFIX), value.lastIndexOf(COLOR_SCHEME_REPORT_PREFIX))
  if (started >= 0) return started
  const escape = value.lastIndexOf('\u001b')
  if (escape < 0) return -1
  const suffix = value.slice(escape)
  return BACKGROUND_RESPONSE_PREFIX.startsWith(suffix) || COLOR_SCHEME_REPORT_PREFIX.startsWith(suffix) ? escape : -1
}

function parseBackgroundMode(response: string): ResolvedColorMode | undefined {
  const terminatorLength = response.endsWith('\u001b\\') ? 2 : 1
  const match = BACKGROUND_VALUE.exec(response.slice(BACKGROUND_RESPONSE_PREFIX.length, -terminatorLength))
  if (!match) return undefined
  const channels = [match[1]!, match[2]!, match[3]!].map(
    (value) => Number.parseInt(value, 16) / (16 ** value.length - 1)
  )
  const linear = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  return luminance > 0.179 ? 'light' : 'dark'
}

function setColorMode(mode: ResolvedColorMode): void {
  if (mode === detectedMode) return
  detectedMode = mode
  for (const listener of modeListeners) listener()
}
