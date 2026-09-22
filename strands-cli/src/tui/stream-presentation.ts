import type { ChatEvent, ChatRunResult } from './chat/controller.js'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface StreamPresentationOptions {
  frameIntervalMs?: number
  minChunkSize?: number
  maxBufferedText?: number
  targetDrainFrames?: number
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export const DEFAULT_STREAM_PRESENTATION: Required<Omit<StreamPresentationOptions, 'delay'>> = {
  frameIntervalMs: 32,
  minChunkSize: 5,
  maxBufferedText: 480,
  targetDrainFrames: 8,
}

type TextEvent = Extract<ChatEvent, { type: 'reasoningDelta' | 'textDelta' }>

interface TextQueueItem {
  kind: 'text'
  type: TextEvent['type']
  content: string[]
  offset: number
}

type QueueItem = TextQueueItem | { kind: 'event'; event: Exclude<ChatEvent, TextEvent> }

export async function* presentChatStream(
  source: AsyncGenerator<ChatEvent, ChatRunResult, undefined>,
  requested: StreamPresentationOptions = {},
  signal?: AbortSignal
): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
  const options = {
    ...DEFAULT_STREAM_PRESENTATION,
    ...requested,
    delay: requested.delay ?? delay,
  }
  const maxBufferedText = Math.max(1, Math.ceil(options.maxBufferedText))
  const maxQueuedItems = Math.max(1, Math.ceil(options.targetDrainFrames))
  const queue: QueueItem[] = []
  const waiters = new Set<() => void>()
  let bufferedText = 0
  let sourceDone = false
  let sourceResult: ChatRunResult | undefined
  let sourceError: unknown

  const notify = (): void => {
    for (const resolve of waiters) {
      resolve()
    }
    waiters.clear()
  }
  const waitForChange = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      waiters.add(resolve)
    })
  }

  const pump = (async (): Promise<void> => {
    try {
      while (true) {
        while (!(bufferedText < maxBufferedText && queue.length < maxQueuedItems)) {
          await waitForChange()
        }

        const next = await source.next()
        if (next.done) {
          sourceResult = next.value
          break
        }

        const event = next.value
        if (event.type === 'reasoningDelta' || event.type === 'textDelta') {
          const previous = queue.at(-1)
          const content = [...SEGMENTER.segment(event.text)].map((segment) => segment.segment)
          bufferedText += content.length
          if (content.length > 0 && previous?.kind === 'text' && previous.type === event.type) {
            for (const grapheme of content) {
              previous.content.push(grapheme)
            }
          } else {
            queue.push({ kind: 'text', type: event.type, content, offset: 0 })
          }
        } else {
          queue.push({ kind: 'event', event })
        }
        notify()
      }
    } catch (error) {
      sourceError = error
    } finally {
      sourceDone = true
      notify()
    }
  })()

  let remainingDelayFrames = Math.max(0, Math.ceil(options.targetDrainFrames))
  while (true) {
    while (queue.length === 0 && !sourceDone) {
      await waitForChange()
    }
    if (queue.length === 0) {
      break
    }

    const item = queue[0]!
    if (item.kind === 'event') {
      queue.shift()
      notify()
      yield item.event
      continue
    }

    while (true) {
      const remaining = item.content.length - item.offset
      if (remaining > 0) {
        const framesLeft = Math.max(1, remainingDelayFrames)
        const smoothChunkSize = Math.max(options.minChunkSize, Math.ceil(remaining / framesLeft))
        const chunkSize = remainingDelayFrames === 0 ? remaining : Math.min(remaining, smoothChunkSize)
        const text = item.content.slice(item.offset, item.offset + chunkSize).join('')
        item.offset += chunkSize
        bufferedText -= chunkSize
        notify()
        yield { type: item.type, text }

        const itemDrained = item.offset >= item.content.length
        const sealed = queue.length > 1 || sourceDone
        if (remainingDelayFrames > 0 && !(itemDrained && sealed)) {
          remainingDelayFrames--
          await options.delay(options.frameIntervalMs, signal)
        }
        continue
      }

      const sealed = queue.length > 1 || sourceDone
      if (sealed) {
        queue.shift()
        notify()
        break
      }
      await waitForChange()
    }
  }

  await pump
  if (sourceError !== undefined) {
    throw sourceError
  }
  if (!sourceResult) {
    throw new Error('Chat stream ended without a result.')
  }
  return sourceResult
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
