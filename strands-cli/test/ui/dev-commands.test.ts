import { describe, expect, it, vi } from 'vitest'

import { ChatController, type DevChatCommand, type DevChatCommandContext } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'

const devCommand = (run: DevChatCommand['run'] = vi.fn()): DevChatCommand => ({
  spec: { name: 'optimize', usage: '/optimize [experiment]', description: 'Tune this agent' },
  run,
})

const capture = (): { command: DevChatCommand; context: () => DevChatCommandContext; argument: () => string } => {
  let received: { argument: string; context: DevChatCommandContext } | undefined
  const command = devCommand((argument, context) => {
    received = { argument, context }
  })
  return { command, context: () => received!.context, argument: () => received!.argument }
}

describe('dev chat commands', () => {
  it('shouldRunTheDevCommandWithItsArgumentWhenTheUserTypesIt', async () => {
    const stream = vi.fn()
    const { command, argument } = capture()
    const controller = new ChatController(idleBackend({ stream }), { devCommands: [command] })

    await controller.submit('/optimize support -- --tune effort')

    expect(argument()).toBe('support -- --tune effort')
    expect(stream).not.toHaveBeenCalled()
  })

  it('shouldOfferTheDevCommandWhenTheUserTypesASlash', () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })

    expect(controller.actionableCommandToken('/optimize')).toBe('/optimize')
    expect(controller.commandAssistance('/opt')?.completions).toEqual([expect.objectContaining({ name: 'optimize' })])
  })

  it('shouldListTheDevCommandsBeforeTheBuiltInCommandsWhenTheUserTypesOnlyASlash', () => {
    const experiment = {
      ...devCommand(),
      spec: { name: 'experiment', usage: '/experiment <name>', description: 'Make cases' },
    }
    const controller = new ChatController(idleBackend(), { devCommands: [experiment, devCommand()] })

    const names = controller.commandAssistance('/')?.completions.map((command) => command.name)

    expect(names?.slice(0, 3)).toEqual(['experiment', 'optimize', 'help'])
  })

  it('shouldListTheDevCommandsInHelpWhenTheUserOpensIt', async () => {
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand()] })

    await controller.submit('/help')

    const rows = controller.getSnapshot().panel?.rows.filter((row) => row.section === 'Commands') ?? []
    expect(rows[0]).toMatchObject({ label: '/optimize [experiment]', description: 'Tune this agent' })
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
