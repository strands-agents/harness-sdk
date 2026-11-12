import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  TemporaryJobNotice,
  tailTemporaryLines,
  watchTemporaryFileCount,
} from '../../../src/dev/temporary-evals-fork/jobs.js'
import type { ChatNotice, DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const chat = () => {
  const notices: { status: ChatNotice['status']; text: string }[] = []
  const context: DevChatCommandContext = {
    signal: new AbortController().signal,
    report: (status, text) => {
      const notice = { status, text }
      notices.push(notice)
      return {
        update: (nextStatus, nextText): void => {
          notice.status = nextStatus
          notice.text = nextText
        },
      }
    },
    fail: vi.fn(),
  }
  return { context, notices }
}

describe('TemporaryJobNotice', () => {
  it('shouldUpdateTheNoticeInEveryAttachedChatWhenTheJobProgresses', () => {
    const first = chat()
    const second = chat()
    const notice = new TemporaryJobNotice()

    notice.start(first.context, 'test · 0/4 cases run')
    notice.attach(second.context)
    notice.update('test · 2/4 cases run')

    expect(first.notices).toEqual([{ status: 'running', text: 'test · 2/4 cases run' }])
    expect(second.notices).toEqual([{ status: 'running', text: 'test · 2/4 cases run' }])
  })

  it('shouldNotShowAFinishedJobWhenANewChatAttaches', () => {
    const first = chat()
    const later = chat()
    const notice = new TemporaryJobNotice()
    notice.start(first.context, 'test · 0/4 cases run')

    notice.finish('success', 'test · 4 of 4 cases passed')
    notice.attach(later.context)

    expect(first.notices).toEqual([{ status: 'success', text: 'test · 4 of 4 cases passed' }])
    expect(later.notices).toEqual([])
  })
})

describe('tailTemporaryLines', () => {
  it('shouldDeliverEachCompleteLineOnceWhenTheFileGrows', async () => {
    const path = join(await temporaryDirectory(), 'study.jsonl')
    const lines: string[] = []
    await writeFile(path, '{"type":"study"}\n{"type":')

    const tail = tailTemporaryLines(path, (line) => lines.push(line))
    await vi.waitFor(() => expect(lines).toEqual(['{"type":"study"}']))
    await appendFile(path, '"run"}\n')
    await vi.waitFor(() => expect(lines).toEqual(['{"type":"study"}', '{"type":"run"}']))
    await tail.stop()

    expect(lines).toEqual(['{"type":"study"}', '{"type":"run"}'])
  })

  it('shouldWaitWithoutFailingWhenTheFileDoesNotExistYet', async () => {
    const path = join(await temporaryDirectory(), 'later', 'study.jsonl')
    const lines: string[] = []

    const tail = tailTemporaryLines(path, (line) => lines.push(line))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{"type":"study"}\n')
    await tail.stop()

    expect(lines).toEqual(['{"type":"study"}'])
  })
})

describe('watchTemporaryFileCount', () => {
  it('shouldReportTheNumberOfFinishedCaseFilesWhenTheFolderFills', async () => {
    const folder = join(await temporaryDirectory(), 'cases')
    const counts: number[] = []

    const stop = watchTemporaryFileCount(folder, (count) => counts.push(count))
    await mkdir(folder)
    await writeFile(join(folder, 'c0.json'), '{}')
    await writeFile(join(folder, 'c1.json'), '{}')
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2))
    stop()

    expect(counts).not.toContain(3)
  })
})
