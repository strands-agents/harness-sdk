import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type DevChatCommand,
  type DevChatCommandContext,
  type DevChatPanelView,
} from '../../src/ui/chat/controller.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import type { DevChatJob, DevChatJobs } from '../../src/ui/chat/types.js'
import { idleBackend } from '../fixtures/chat-backend.js'

const EmptyPanel: DevChatPanelView = () => null

const devCommand = (open: DevChatCommand['open'] = vi.fn(() => EmptyPanel)): DevChatCommand => ({
  spec: { name: 'optimize', usage: '/optimize', description: 'Tune this agent' },
  open,
})

const capture = (): { command: DevChatCommand; context: () => DevChatCommandContext } => {
  let received: DevChatCommandContext | undefined
  const command = devCommand((context) => {
    received = context
    return EmptyPanel
  })
  return { command, context: () => received! }
}

describe('dev chat commands', () => {
  it('shouldOpenTheDevCommandPanelWhenTheUserTypesIt', async () => {
    const stream = vi.fn()
    const open = vi.fn(() => EmptyPanel)
    const controller = new ChatController(idleBackend({ stream }), { devCommands: [devCommand(open)] })

    await controller.submit('/optimize')

    expect(open).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/optimize', view: EmptyPanel })
    expect(stream).not.toHaveBeenCalled()
  })

  it('shouldCloseTheDevPanelWhenTheViewAsksToClose', async () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })
    await controller.submit('/optimize')
    const panel = controller.getSnapshot().panel

    if (panel?.kind === 'dev') panel.close()

    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('shouldKeepAnotherPanelWhenAnOldDevPanelAsksToClose', async () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })
    await controller.submit('/optimize')
    const panel = controller.getSnapshot().panel
    await controller.submit('/help')

    if (panel?.kind === 'dev') panel.close()

    expect(controller.getSnapshot().panel?.kind).toBe('help')
  })

  it('shouldOfferTheDevCommandWhenTheUserTypesASlash', () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })

    expect(controller.actionableCommandToken('/optimize')).toBe('/optimize')
    expect(controller.commandAssistance('/opt')?.completions).toEqual([expect.objectContaining({ name: 'optimize' })])
  })

  it('shouldListTheDevCommandsBeforeTheBuiltInCommandsWhenTheUserTypesOnlyASlash', () => {
    const experiment = {
      ...devCommand(),
      spec: { name: 'experiment', usage: '/experiment', description: 'Make cases' },
    }
    const controller = new ChatController(idleBackend(), { devCommands: [experiment, devCommand()] })

    const names = controller.commandAssistance('/')?.completions.map((command) => command.name)

    expect(names?.slice(0, 3)).toEqual(['experiment', 'optimize', 'help'])
  })

  it('shouldListTheDevCommandsInHelpWhenTheUserOpensIt', async () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })

    await controller.submit('/help')

    const rows = controller.getSnapshot().panel?.rows.filter((row) => row.section === 'Commands') ?? []
    expect(rows[0]).toMatchObject({ label: '/optimize', description: 'Tune this agent' })
  })

  it('shouldShowTheUsageInsteadOfOpeningWhenTheUserPicksADevCommandInHelp', async () => {
    const open = vi.fn(() => EmptyPanel)
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand(open)] })
    await controller.submit('/help')
    const row = controller.getSnapshot().panel!.rows.find((candidate) => candidate.label === '/optimize')!

    await controller.activatePanelRow(row)

    expect(open).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'help-detail', body: 'Tune this agent' })
  })

  it('shouldTreatTheCommandAsUnknownWhenNoDevCommandsAreGiven', async () => {
    const controller = new ChatController(idleBackend())

    expect(controller.actionableCommandToken('/optimize')).toBeUndefined()
  })

  it('shouldUpdateTheSameNoticeWhenTheDevCommandReportsProgress', async () => {
    const { command, context } = capture()
    const controller = new ChatController(idleBackend(), { devCommands: [command] })
    await controller.submit('/optimize')

    const notice = context().report('running', 'Optimizing · candidate 0')
    notice.update('success', 'Optimization finished')

    const notices = controller.getSnapshot().notices.filter((candidate) => candidate.text.startsWith('Optimiz'))
    expect(notices).toEqual([expect.objectContaining({ status: 'success', text: 'Optimization finished' })])
  })

  it('shouldShowTheNoticeAgainWhenTheConversationWasClearedBeforeAnUpdate', async () => {
    const { command, context } = capture()
    const controller = new ChatController(idleBackend({ clear: vi.fn(async () => {}) }), { devCommands: [command] })
    await controller.submit('/optimize')
    const notice = context().report('running', 'Optimizing')

    await controller.submit('/clear')
    expect(controller.getSnapshot().notices).not.toContainEqual(expect.objectContaining({ text: 'Optimizing' }))
    notice.update('success', 'Optimization finished')

    expect(controller.getSnapshot().notices).toContainEqual(expect.objectContaining({ text: 'Optimization finished' }))
  })

  it('shouldMoveTheNoticeBelowTheNewestTurnWhenTheDevCommandUpdatesIt', async () => {
    const { command, context } = capture()
    const controller = new ChatController(idleBackend(), { devCommands: [command] })
    await controller.submit('/optimize')
    const notice = context().report('running', 'Optimizing')

    await controller.submit('first question')
    notice.update('running', 'Optimizing · candidate 1')

    const newest = controller.getSnapshot().completedTurns.at(-1)!.id
    expect(controller.getSnapshot().notices).toContainEqual(
      expect.objectContaining({ text: 'Optimizing · candidate 1', afterTurnId: newest })
    )
    expect(controller.getSnapshot().notices.filter((candidate) => candidate.text.startsWith('Optimiz'))).toHaveLength(1)
  })

  it('shouldLetTheDevCommandAttachWhenTheControllerStarts', () => {
    const attach = vi.fn<NonNullable<DevChatCommand['attach']>>(
      (context) => void context.report('running', 'Resumed view')
    )

    const controller = new ChatController(idleBackend(), { devCommands: [{ ...devCommand(), attach }] })

    expect(attach).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().notices).toContainEqual(expect.objectContaining({ text: 'Resumed view' }))
  })

  it('shouldAbortTheDevCommandSignalWhenTheControllerCloses', async () => {
    const { command, context } = capture()
    const controller = new ChatController(idleBackend(), { devCommands: [command] })
    await controller.submit('/optimize')

    controller.close()

    expect(context().signal.aborted).toBe(true)
  })
})

const jobStore = (): DevChatJobs & { set: (jobs: readonly DevChatJob[]) => void; listeners: () => number } => {
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

const named = (name: string): DevChatCommand => ({
  ...devCommand(),
  spec: { name, usage: `/${name}`, description: name },
})

describe('dev command jobs and panels', () => {
  it.each([
    ['optimize', true, 'dev'],
    ['missing', false, undefined],
  ])('shouldOpenThePanelOf%sOnlyWhenTheCommandExists', (name, opened, kind) => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })

    const result = controller.openDevCommand(name)

    expect(result).toBe(opened)
    expect(controller.getSnapshot().panel?.kind).toBe(kind)
  })

  it('shouldOpenAnotherDevPanelWhenAPanelAsksForIt', async () => {
    const controller = new ChatController(idleBackend(), { devCommands: [named('test'), named('experiment')] })
    await controller.submit('/test')
    const panel = controller.getSnapshot().panel

    const opened = panel?.kind === 'dev' ? panel.openCommand('experiment') : false

    expect(opened).toBe(true)
    expect(controller.getSnapshot().panel?.title).toBe('/experiment')
  })

  it('shouldListOnlyTheCommandsWithRunningJobsWhenJobsChange', () => {
    const experiment = jobStore()
    const commands = [
      { ...named('experiment'), jobs: experiment },
      { ...named('test'), jobs: jobStore() },
    ]
    const controller = new ChatController(idleBackend(), { devCommands: commands })

    experiment.set([{ id: 'g1', label: 'refunds', done: 3, total: 20 }])
    const running = controller.getSnapshot().devJobs
    experiment.set([])

    expect(running).toEqual([{ command: 'experiment', jobs: [{ id: 'g1', label: 'refunds', done: 3, total: 20 }] }])
    expect(controller.getSnapshot().devJobs).toBeUndefined()
  })

  it('shouldStopListeningForJobsWhenTheControllerIsDisposed', async () => {
    const jobs = jobStore()
    const controller = new ChatController(idleBackend(), { devCommands: [{ ...devCommand(), jobs }] })

    await controller.dispose()

    expect(jobs.listeners()).toBe(0)
  })

  it('shouldOpenTheDevPanelAtOnceWhenTheUserTypesItDuringATurn', async () => {
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const controller = new ChatController(
      idleBackend({
        async *stream() {
          await finished
          yield* []
          return { stopReason: 'endTurn', context: {} }
        },
      }),
      { devCommands: [devCommand()] }
    )
    const turn = controller.submit('a long question')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    await controller.submit('/optimize')

    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/optimize' })
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    finish()
    await turn
  })

  it('shouldOpenTheDevPanelOfTheActiveConversationWhenTheManagerIsAsked', () => {
    const manager = new ConversationManager(new ChatController(idleBackend(), { devCommands: [devCommand()] }), {
      fork: async () => new ChatController(idleBackend()),
    })

    const opened = manager.openDevCommand('optimize')

    expect(opened).toBe(true)
    expect(manager.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/optimize' })
  })
})
