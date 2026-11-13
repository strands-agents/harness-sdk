import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'

import { type Instance } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
import { type ChatBackend, type ChatPermissionRequest } from '../../src/agent/types.js'
import * as attachmentFiles from '../../src/ui/chat/attachments.js'
import * as filePicker from '../../src/terminal/directory-picker.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const instances: Instance[] = []
const controllers: ChatControllerApi[] = []
const permissionRequest: ChatPermissionRequest = {
  id: 'new-request',
  toolName: 'shell',
  input: { command: 'dangerous operation' },
  action: 'dangerous operation',
  options: [
    { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
    { id: 'deny', label: 'Deny once', kind: 'reject_once' },
  ],
}

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
  }
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  vi.restoreAllMocks()
})

describe('/file', () => {
  it('attaches explicit paths and sends their content with the next prompt', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const path = join(root, 'frog notes.md')
    await writeFile(path, '# Frog notes')
    const { controller, input, frame, instance, stream } = await mount(root)

    input.write(`/file "${path}"`)
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(frame()).toMatch(/frog notes\.md.*12 B/u))

    input.write('Summarize this')
    await vi.waitFor(() => expect(frame()).toContain('Summarize this'))
    input.write('\r')

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toEqual([
      { text: 'Summarize this' },
      {
        document: {
          name: 'frog notes md',
          format: 'md',
          source: { text: '# Frog notes' },
        },
      },
    ])
    expect(controller.getSnapshot().completedTurns[0]).toMatchObject({
      prompt: 'Summarize this',
      attachments: [{ name: 'frog notes.md', kind: 'document' }],
    })
  })

  it('treats a dragged or pasted file path as an attachment', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const path = join(root, 'frog.png')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    const { input, frame, stream } = await mount(root)

    input.write(`\u001b[200~"${path}"\u001b[201~`)
    await vi.waitFor(() => expect(frame()).toContain('frog.png'))
    input.write('\r')

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toEqual([
      { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
    ])
  })

  it.each(['clear', 'submit'])('does not restore pending attachments after %s', async (action) => {
    const root = await temporaryDirectory('strands-file-command-')
    await writeFile(join(root, 'secret.txt'), 'secret')
    await writeFile(join(root, 'late.txt'), 'late')
    await writeFile(join(root, 'fresh.txt'), 'fresh')
    const { input, frame, instance, stream } = await mount(root)
    await send(input, instance, '/file secret.txt')
    await vi.waitFor(() => expect(frame()).toContain('secret.txt'))
    const gate = deferred<void>()
    const finished = deferred<void>()
    const load = attachmentFiles.loadAttachments
    vi.spyOn(attachmentFiles, 'loadAttachments').mockImplementation(async (paths, cwd) => {
      if (paths.includes('late.txt')) {
        await gate.promise
        try {
          return await load(paths, cwd)
        } finally {
          finished.resolve()
        }
      }
      return load(paths, cwd)
    })
    await send(input, instance, '/file late.txt')
    await send(input, instance, action === 'clear' ? '/file clear' : 'first')
    await send(input, instance, '/file fresh.txt')
    await vi.waitFor(() => expect(frame()).toContain('fresh.txt'))
    gate.resolve()
    await finished.promise
    await instance.waitUntilRenderFlush()
    await send(input, instance, 'second')

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(action === 'clear' ? 1 : 2))
    expect(stream.mock.calls.at(-1)?.[0]).toEqual([
      { text: 'second' },
      { document: { name: 'fresh txt', format: 'txt', source: { text: 'fresh' } } },
    ])
  })

  it('keeps both attachments when additions overlap', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    await writeFile(join(root, 'first.txt'), 'first')
    await writeFile(join(root, 'second.txt'), 'second')
    const { input, frame, instance, stream } = await mount(root)
    const gate = deferred<void>()
    const load = attachmentFiles.loadAttachments
    vi.spyOn(attachmentFiles, 'loadAttachments').mockImplementation(async (paths, cwd) => {
      if (paths.includes('first.txt')) await gate.promise
      return load(paths, cwd)
    })
    await send(input, instance, '/file first.txt')
    await send(input, instance, '/file second.txt')
    gate.resolve()
    await vi.waitFor(() => {
      expect(frame()).toContain('first.txt')
      expect(frame()).toContain('second.txt')
    })
    await send(input, instance, 'both')

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toEqual([
      { text: 'both' },
      { document: { name: 'first txt', format: 'txt', source: { text: 'first' } } },
      { document: { name: 'second txt', format: 'txt', source: { text: 'second' } } },
    ])
  })

  it('ignores a native picker result after attachments are cleared', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const { input, instance, stream } = await mount(root)
    const selection = deferred<string[]>()
    vi.spyOn(filePicker, 'canUseNativePicker').mockReturnValue(true)
    vi.spyOn(filePicker, 'chooseFiles').mockReturnValue(selection.promise)
    vi.spyOn(attachmentFiles, 'loadAttachments').mockResolvedValue([
      {
        path: join(root, 'late.txt'),
        name: 'late.txt',
        size: 4,
        kind: 'document',
        content: { document: { name: 'late txt', format: 'txt', source: { text: 'late' } } },
      },
    ])
    await send(input, instance, '/file')
    await send(input, instance, '/file clear')
    selection.resolve([join(root, 'late.txt')])
    await instance.waitUntilRenderFlush()
    await send(input, instance, 'without files')

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toBe('without files')
  })

  it('preserves paste, typing, and submit order while classifying a paste', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const { input, frame, instance, stream } = await mount(root)
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~hello\u001b[201~')
    await instance.waitUntilRenderFlush()
    input.write('world')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    gate.resolve(undefined)

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toBe('helloworld')
    await instance.waitUntilRenderFlush()
    expect(frame()).not.toContain('hello▌')
  })

  it('cancels a pending paste immediately on Ctrl-C', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const { controller, input, instance, stream } = await mount(root)
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~late\u001b[201~')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    input.write('\u0003')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('closed'))
    gate.resolve(undefined)
    await instance.waitUntilExit()

    expect(stream).not.toHaveBeenCalled()
  })

  it('refreshes command suggestions before replaying a queued Enter', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const { controller, input, instance } = await mount(root)
    const submitted = vi.spyOn(controller, 'submit')
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('/s')
    await instance.waitUntilRenderFlush()
    input.write('\u001b[200~ettings\u001b[201~')
    await vi.waitFor(() => expect(attachmentFiles.filePathsFromPaste).toHaveBeenCalledWith('ettings', root))
    input.write('\r')
    await instance.waitUntilRenderFlush()
    gate.resolve(undefined)

    await vi.waitFor(() => expect(submitted.mock.calls).toEqual([['/settings']]))
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
  })

  it.each([false, true])('requires fresh input for an arriving permission (before paste settles=%s)', async (early) => {
    const root = await temporaryDirectory('strands-file-command-')
    let permissionListener!: (request: ChatPermissionRequest | undefined) => void
    const respondPermission = vi.fn(() => {
      permissionListener(undefined)
      return true
    })
    const { controller, input, instance, stream } = await mount(root, {
      watchPermissions(listener) {
        permissionListener = listener
        return () => {}
      },
      respondPermission,
    })
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~hello\u001b[201~')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    permissionListener(permissionRequest)
    await instance.waitUntilRenderFlush()
    if (early) {
      input.write('\r')
      await vi.waitFor(() => expect(respondPermission).toHaveBeenCalledOnce())
    }
    gate.resolve(undefined)
    await instance.waitUntilRenderFlush()

    expect(respondPermission).toHaveBeenCalledTimes(early ? 1 : 0)
    expect(stream).not.toHaveBeenCalled()
    if (!early) {
      expect(controller.getSnapshot().panel?.kind).toBe('permission')
      input.write('\r')
      await vi.waitFor(() => expect(respondPermission).toHaveBeenCalledOnce())
    }
  })

  it('does not replay a second Enter into a permission requested by the submitted turn', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    let permissionListener!: (request: ChatPermissionRequest | undefined) => void
    const completion = deferred<void>()
    const respondPermission = vi.fn(() => true)
    const { controller, input, instance } = await mount(root, {
      watchPermissions(listener) {
        permissionListener = listener
        return () => {}
      },
      respondPermission,
      async *stream() {
        permissionListener(permissionRequest)
        await completion.promise
        yield { type: 'textDelta', text: 'Done.' }
        return { stopReason: 'endTurn' }
      },
    })
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~hello\u001b[201~')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    gate.resolve(undefined)
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
    await instance.waitUntilRenderFlush()

    expect(respondPermission).not.toHaveBeenCalled()
    input.write('\r')
    await vi.waitFor(() => expect(respondPermission).toHaveBeenCalledOnce())
    completion.resolve()
  })

  it('replays queued input against the panel opened by the preceding input', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const { controller, input, instance, stream } = await mount(root)
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~/settings\u001b[201~')
    await instance.waitUntilRenderFlush()
    for (const text of ['\r', '\u001b', '\u001b', 'after settings', '\r']) {
      input.write(text)
      await instance.waitUntilRenderFlush()
    }
    gate.resolve(undefined)

    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    expect(stream.mock.calls[0]?.[0]).toBe('after settings')
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('does not send a pending paste to a fork that becomes active during classification', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const forkGate = deferred<ChatController>()
    const { controller, input, instance, stream } = await mount(root, {}, () => forkGate.promise)
    const forkStream = vi.fn<ChatBackend['stream']>(async function* () {
      yield { type: 'textDelta', text: 'Done.' }
      return { stopReason: 'endTurn' }
    })
    const forking = controller.submit('/fork')
    const gate = deferred<string[] | undefined>()
    vi.spyOn(attachmentFiles, 'filePathsFromPaste').mockReturnValueOnce(gate.promise)
    input.write('\u001b[200~hello\u001b[201~')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    forkGate.resolve(
      new ChatController(idleBackend({ id: 'file-test', stream: forkStream }), {
        runtime: { cwd: root },
        settings: { animations: false },
      })
    )
    await forking
    await instance.waitUntilRenderFlush()
    gate.resolve(undefined)
    await instance.waitUntilRenderFlush()
    await instance.waitUntilRenderFlush()

    expect(stream).not.toHaveBeenCalled()
    expect(forkStream).not.toHaveBeenCalled()
    await send(input, instance, 'new conversation')
    await vi.waitFor(() => expect(forkStream).toHaveBeenCalledOnce())
    expect(forkStream.mock.calls[0]?.[0]).toBe('new conversation')
  })
})

async function send(input: ReturnType<typeof ttyInput>, instance: Instance, text: string): Promise<void> {
  input.write(text)
  await instance.waitUntilRenderFlush()
  input.write('\r')
  await instance.waitUntilRenderFlush()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function mount(
  cwd: string,
  backendOptions: Partial<ChatBackend> = {},
  fork?: () => Promise<ChatController>
): Promise<{
  controller: ChatControllerApi
  input: ReturnType<typeof ttyInput>
  frame: () => string
  instance: Instance
  stream: ReturnType<typeof vi.fn<ChatBackend['stream']>>
}> {
  const input = ttyInput()
  const output = ttyOutput(100, 24)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    frame = sanitizeTerminalText(chunk.toString())
  })
  const stream = vi.fn<ChatBackend['stream']>(async function* () {
    yield { type: 'textDelta', text: 'Done.' }
    return { stopReason: 'endTurn' }
  })
  const initial = new ChatController(
    idleBackend({
      id: 'file-test',
      stream,
      ...backendOptions,
    }),
    {
      runtime: { cwd },
      settings: { animations: false },
    }
  )
  const controller = fork ? new ConversationManager(initial, { fork }) : initial
  controllers.push(controller)
  const instance = render(createElement(ChatApp, { controller }), {
    stdin: input,
    stdout: output,
    stderr: ttyOutput(100, 24),
    exitOnCtrlC: false,
    interactive: true,
    debug: true,
    patchConsole: false,
  })
  instances.push(instance)
  await instance.waitUntilRenderFlush()
  return { controller, input, frame: () => frame, instance, stream }
}
