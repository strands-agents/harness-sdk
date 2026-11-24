import { createElement, type ReactElement } from 'react'
import { type Instance } from 'ink'
import { afterEach } from 'vitest'

import type { ChatBackend } from '../../src/agent/types.js'
import { ChatController, type DevChatCommand, type DevChatJob, type DevChatJobs } from '../../src/ui/chat/controller.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { idleBackend } from './chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from './terminal.js'

const mounted: { instance: Instance; controller: ChatController }[] = []

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

/** `element` on a terminal of `columns` by `rows`, with keys to press and the latest frame to read. */
export async function mountElement(element: ReactElement, columns = 100, rows = 20) {
  const input = ttyInput()
  const output = ttyOutput(columns, rows)
  const frame = captureFrame(output)
  const instance = render(element, { stdin: input, stdout: output, stderr: output })
  await instance.waitUntilRenderFlush()
  const press = async (...keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      input.write(key)
      await instance.waitUntilRenderFlush()
    }
  }
  const row = (text: string): number => frame().findIndex((line) => line.includes(text))
  return { instance, press, row, lines: frame, screen: (): string => frame().join('\n') }
}

/** The chat on a terminal of `columns` by `rows`. */
export async function mountChat({
  devCommands = [],
  columns = 120,
  rows = 40,
  backend = idleBackend(),
}: { devCommands?: readonly DevChatCommand[]; columns?: number; rows?: number; backend?: ChatBackend } = {}) {
  const controller = new ChatController(backend, {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands,
  })
  const view = await mountElement(createElement(ChatApp, { controller }), columns, rows)
  mounted.push({ instance: view.instance, controller })
  return { controller, ...view }
}

/** The jobs of a dev command, as a test sets them. */
export const jobStore = (): DevChatJobs & { set: (jobs: readonly DevChatJob[]) => void; listeners: () => number } => {
  let jobs: readonly DevChatJob[] = []
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => jobs,
    set: (next) => {
      jobs = next
      for (const listener of listeners) listener()
    },
    listeners: () => listeners.size,
  }
}
