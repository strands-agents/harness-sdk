import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'

import { render, renderToString, type Instance } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatApp } from '../src/tui/view/app.js'
import { PromptEditor } from '../src/tui/view/prompt-editor.js'
import { idleBackend } from './fixtures/chat-backend.js'
import { temporaryDirectory } from './fixtures/tempdir.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const instances: Instance[] = []
const controllers: ChatController[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
  }
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

describe('/file', () => {
  it('renders attached file metadata in the composer', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '',
        cursor: 0,
        width: 60,
        attachments: [{ name: 'frog.png', size: 1536, kind: 'image' }],
      }),
      { columns: 60 }
    )

    expect(output).toContain('frog.png')
    expect(output).toContain('1.5 KB')
    expect(output).toContain('Enter to send')
  })

  it('attaches explicit paths and sends their content with the next prompt', async () => {
    const root = await temporaryDirectory('strands-file-command-')
    const path = join(root, 'frog notes.md')
    await writeFile(path, '# Frog notes')
    const { controller, input, frame, instance, stream } = await mount(root)

    input.write(`/file "${path}"`)
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await vi.waitFor(() => expect(frame()).toContain('frog notes.md'))

    input.write('Summarize this')
    await instance.waitUntilRenderFlush()
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
})

async function mount(cwd: string): Promise<{
  controller: ChatController
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
  const controller = new ChatController(
    idleBackend({
      id: 'file-test',
      stream,
    }),
    {
      runtime: { cwd },
      settings: { animations: false },
    }
  )
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
