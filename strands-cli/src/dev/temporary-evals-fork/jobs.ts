import { open, readdir } from 'node:fs/promises'

import type { ChatNotice, DevChatCommandContext, DevChatNotice } from '../../ui/chat/types.js'
import { isRecord } from '../../values.js'

const TAIL_INTERVAL_MS = 1000
const COUNT_INTERVAL_MS = 500

export class TemporaryJobNotice {
  private views: DevChatNotice[] = []
  private latest: { status: ChatNotice['status']; text: string } | undefined

  start(context: DevChatCommandContext | undefined, text: string): void {
    this.latest = { status: 'running', text }
    this.views = context ? [context.report('running', text)] : []
  }

  attach(context: DevChatCommandContext): void {
    if (this.latest?.status === 'running') this.views.push(context.report('running', this.latest.text))
  }

  update(text: string): void {
    this.show('running', text)
  }

  finish(status: 'success' | 'error', text: string): void {
    this.show(status, text)
    this.latest = undefined
    this.views = []
  }

  private show(status: ChatNotice['status'], text: string): void {
    if (this.latest?.text === text && this.latest.status === status) return
    this.latest = { status, text }
    for (const view of this.views) view.update(status, text)
  }
}

export interface TemporaryTail {
  stop(): Promise<void>
}

export const tailTemporaryLines = (path: string, onLine: (line: string) => void): TemporaryTail => {
  let offset = 0
  let partial = ''
  let reading: Promise<void> = Promise.resolve()
  const read = async (): Promise<void> => {
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      const lines = (partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    } finally {
      await handle.close()
    }
  }
  const tick = (): void => {
    reading = reading.then(read).catch(() => undefined)
  }
  const timer = setInterval(tick, TAIL_INTERVAL_MS)
  timer.unref()
  tick()
  return {
    stop: async (): Promise<void> => {
      clearInterval(timer)
      tick()
      await reading
      if (partial.trim()) onLine(partial)
      partial = ''
    },
  }
}

export const watchTemporaryFileCount = (folder: string, onCount: (count: number) => void): (() => void) => {
  let last = -1
  const count = async (): Promise<void> => {
    try {
      const found = (await readdir(folder)).filter((name) => name.endsWith('.json')).length
      if (found !== last) {
        last = found
        onCount(found)
      }
    } catch {
      return
    }
  }
  const timer = setInterval(() => void count(), COUNT_INTERVAL_MS)
  timer.unref()
  void count()
  return () => clearInterval(timer)
}
