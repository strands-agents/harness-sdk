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

const skillCommand = (): DevChatCommand => ({
  spec: { name: 'evaluate', usage: '/evaluate [request]', description: 'Run the cases' },
  skill: {
    skill: 'strands-evals',
    workflow: 'Run the cases.',
    unavailable: 'The skill did not load.',
    job: (id) => `how is ${id} going?`,
  },
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

  it('shouldExplainTheDevCommandBelowItsSummaryWhenTheUserPicksItInHelp', async () => {
    const explained: DevChatCommand = {
      ...devCommand(),
      spec: {
        name: 'optimize',
        usage: '/optimize',
        description: 'Tune this agent',
        details: 'Select an experiment.\n\nReview the edits.',
      },
    }
    const controller = new ChatController(idleBackend(), { devCommands: [explained] })
    await controller.submit('/help')
    const row = controller.getSnapshot().panel!.rows.find((candidate) => candidate.label === '/optimize')!

    await controller.activatePanelRow(row)

    expect(row.description.split('\n')[0]).toBe('Tune this agent')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'help-detail',
      title: '/optimize',
      body: 'Tune this agent\n\nSelect an experiment.\n\nReview the edits.',
    })
  })

  it('shouldTreatTheCommandAsUnknownWhenNoDevCommandsAreGiven', async () => {
    const controller = new ChatController(idleBackend())

    expect(controller.actionableCommandToken('/optimize')).toBeUndefined()
  })

  it('shouldActivateTheSkillAndSendTheWorkflowWhenTheUserTypesASkillCommand', async () => {
    const prompts: unknown[] = []
    const activate = vi.fn(async (name: string) =>
      name === 'strands-evals'
        ? { skill: { name, description: 'Evals', instructions: 'Use evals.', active: true }, content: 'Use evals.' }
        : undefined
    )
    const command = skillCommand()
    const controller = new ChatController(
      idleBackend({
        async *stream(prompt) {
          prompts.push(prompt)
          yield* []
          return { stopReason: 'endTurn' }
        },
      }),
      { devCommands: [command], skills: { list: async () => [], activate } }
    )

    await controller.submit('/evaluate refunds')
    controller.openDevCommand('evaluate', { job: 'refunds.json' })
    await vi.waitFor(() => expect(prompts).toHaveLength(2))

    expect(activate).toHaveBeenCalledWith('strands-evals')
    expect(prompts[0]).toContain('<skill_instructions>\nUse evals.\n</skill_instructions>')
    expect(prompts[0]).toContain('<strands_dev_command name="evaluate">\nRun the cases.\n</strands_dev_command>')
    expect(String(prompts[0]).endsWith('\n\n/evaluate refunds')).toBe(true)
    expect(String(prompts[1]).endsWith('\n\n/evaluate how is refunds.json going?')).toBe(true)
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual([
      '/evaluate refunds',
      '/evaluate how is refunds.json going?',
    ])
    expect(controller.openDevCommand('evaluate', { restore: true })).toBe(false)
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('shouldOpenTheSkillCommandPanelOnlyWhenItsToolAsks', async () => {
    let context: DevChatCommandContext | undefined
    const command: DevChatCommand = {
      ...skillCommand(),
      open: vi.fn(() => EmptyPanel),
      attach: (received) => (context = received),
    }
    const controller = new ChatController(idleBackend(), { devCommands: [command] })
    await controller.start()

    expect(controller.openDevCommand('evaluate')).toBe(true)
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(context!.openPanel('evaluate')).toBe(true)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'evaluate', view: EmptyPanel })
  })

  it('shouldOpenAFileThroughTheScreenOpenerUntilTheScreenRemovesIt', async () => {
    let context: DevChatCommandContext | undefined
    const controller = new ChatController(idleBackend(), {
      devCommands: [{ ...skillCommand(), attach: (received) => (context = received) }],
    })
    await controller.start()
    const opener = vi.fn(async (_path: string): Promise<void> => {})
    const detach = controller.attachFileOpener(opener)

    await context!.openFile!('/w/a.json')
    const removeNewer = controller.attachFileOpener(vi.fn())
    removeNewer()
    // An older opener's removal leaves a newer state alone.
    detach()

    expect(opener).toHaveBeenCalledWith('/w/a.json')
    await expect(context!.openFile!('/w/b.json')).rejects.toThrow('This terminal cannot open an editor.')
  })

  it('shouldKeepOnePanelWaitingUnderAPermissionPromptWhenTheToolAsksTwice', async () => {
    let context: DevChatCommandContext | undefined
    const open = vi.fn(() => EmptyPanel)
    const command: DevChatCommand = { ...skillCommand(), open, attach: (received) => (context = received) }
    const controller = new ChatController(
      idleBackend({
        async *stream() {
          yield {
            type: 'permission',
            request: {
              id: 'permission-1',
              toolName: 'shell',
              input: {},
              options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }],
            },
          }
          await new Promise(() => undefined)
          return { stopReason: 'endTurn' }
        },
        respondPermission: vi.fn(async () => true),
      }),
      { devCommands: [command] }
    )
    await controller.start()
    void controller.submit('hello')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))

    expect([context!.openPanel('evaluate'), context!.openPanel('evaluate'), context!.openPanel('missing')]).toEqual([
      true,
      true,
      false,
    ])
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'evaluate' })
    controller.dismissPanel()

    expect(open).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().panel).toBeUndefined()
    controller.close()
  })

  it('shouldNeitherListNorRunAHiddenCommandButStillOpenItsPanelForATool', async () => {
    let context: DevChatCommandContext | undefined
    const hidden: DevChatCommand = {
      ...devCommand(vi.fn(() => EmptyPanel)),
      spec: { name: 'ask', usage: '/ask', description: 'Answer the question' },
      hidden: true,
      attach: (received) => (context = received),
    }
    const controller = new ChatController(idleBackend(), { devCommands: [hidden] })
    await controller.start()

    expect(controller.actionableCommandToken('/ask')).toBeUndefined()
    expect(controller.commandAssistance('/as')?.completions ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'ask' })
    )
    expect(context!.openPanel('ask')).toBe(true)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'ask' })
  })

  it('shouldExplainWhyWhenTheSkillOfASkillCommandIsMissing', async () => {
    const stream = vi.fn()
    const controller = new ChatController(idleBackend({ stream }), {
      devCommands: [skillCommand()],
      skills: { list: async () => [], activate: async () => undefined },
    })

    await controller.submit('/evaluate')

    expect(stream).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'error' })
    expect(JSON.stringify(controller.getSnapshot().panel)).toContain('The skill did not load.')
  })

  it('shouldRunThePromptAsAUserTurnWhenTheDevCommandSubmitsIt', async () => {
    const prompts: unknown[] = []
    const { command, context } = capture()
    const controller = new ChatController(
      idleBackend({
        async *stream(prompt) {
          prompts.push(prompt)
          yield* []
          return { stopReason: 'endTurn' }
        },
      }),
      { devCommands: [command] }
    )
    await controller.submit('/optimize')

    context().submit('Help me create an experiment')

    await vi.waitFor(() => expect(prompts).toEqual(['Help me create an experiment']))
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

describe('dev panels across turns and repeats', () => {
  const gatedBackend = () => {
    const gates: (() => void)[] = []
    const stream = vi.fn(async function* () {
      await new Promise<void>((resolve) => gates.push(resolve))
      yield* []
      return { stopReason: 'endTurn' as const, context: {} }
    })
    return { backend: idleBackend({ stream }), stream, release: () => gates.shift()?.() }
  }

  it('shouldKeepTheDevPanelOpenWhenAQueuedPromptStartsItsTurn', async () => {
    const { backend, stream, release } = gatedBackend()
    const controller = new ChatController(backend, { devCommands: [devCommand()] })
    const first = controller.submit('first question')
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const second = controller.submit('second question')
    await controller.submit('/optimize')

    release()
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))

    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/optimize' })
    release()
    await Promise.all([first, second])
  })

  it('shouldKeepTheOpenPanelWhenItsOwnCommandOpensAgain', async () => {
    const open = vi.fn(() => EmptyPanel)
    const controller = new ChatController(idleBackend(), { devCommands: [devCommand(open)] })
    await controller.submit('/optimize')
    const before = controller.getSnapshot().panel?.id

    const opened = controller.openDevCommand('optimize')

    expect(opened).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().panel?.id).toBe(before)
  })

  it('shouldKeepTheManagerPanelWhenTheDevCommandCannotOpen', async () => {
    const jobs = jobStore()
    const manager = new ConversationManager(
      new ChatController(idleBackend(), { devCommands: [{ ...devCommand(), jobs }] }),
      { fork: async () => new ChatController(idleBackend()) }
    )
    await manager.submit('/agents')

    const opened = manager.openDevCommand('missing')
    jobs.set([{ id: 'a', label: 'refunds' }])

    expect(opened).toBe(false)
    expect(manager.getSnapshot().panel?.kind).toBe('agents')
  })

  it('shouldShowAJobLabelOnOneLineWhenItHasLineBreaksOrTabs', () => {
    const jobs = jobStore()
    const controller = new ChatController(idleBackend(), { devCommands: [{ ...devCommand(), jobs }] })

    jobs.set([{ id: 'a', label: ' refunds\n\tsecond ', done: 1, total: 2 }])

    expect(controller.getSnapshot().devJobs?.[0]?.jobs[0]?.label).toBe('refunds second')
  })
})

describe('a message typed beside an open dev panel', () => {
  const SHOWN = 'A diff of the run r1 is on screen: effort high → low.'

  /** A panel that stays open while the developer types, such as the diff of a finished run. */
  const standingPanel = (shown: () => string | undefined): DevChatCommand => ({
    spec: { name: 'ask', usage: '/ask', description: 'Answer what is on screen' },
    sticky: true,
    open: () => EmptyPanel,
    screenContext: shown,
  })

  const chat = (commands: readonly DevChatCommand[], skills?: ConstructorParameters<typeof ChatController>[1]) => {
    const prompts: unknown[] = []
    const controller = new ChatController(
      idleBackend({
        async *stream(prompt) {
          prompts.push(prompt)
          yield* []
          return { stopReason: 'endTurn' }
        },
      }),
      { devCommands: [...commands], ...skills }
    )
    return { controller, prompts, shown: () => controller.getSnapshot().completedTurns.map(({ prompt }) => prompt) }
  }

  it('shouldSendWhatThePanelShowsWithTheMessageAndShowOnlyTheMessageInTheChat', async () => {
    const { controller, prompts, shown } = chat([standingPanel(() => SHOWN)])
    await controller.submit('/ask')

    await controller.submit('approve this')

    expect(prompts).toEqual([`<strands_dev_screen>\n${SHOWN}\n</strands_dev_screen>\n\napprove this`])
    expect(shown()).toEqual(['approve this'])
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', command: 'ask' })
  })

  it('shouldReadWhatThePanelShowsWhenTheMessageIsSentAndNotBefore', async () => {
    let showing = 'edit 1 of 2'
    const { controller, prompts } = chat([standingPanel(() => showing)])
    await controller.submit('/ask')
    showing = 'edit 2 of 2'

    await controller.submit('apply it')

    expect(prompts).toEqual(['<strands_dev_screen>\nedit 2 of 2\n</strands_dev_screen>\n\napply it'])
  })

  it.each([
    ['the panel shows nothing a message could be about', [standingPanel(() => undefined)], '/ask'],
    ['the panel is closed', [standingPanel(() => SHOWN)], undefined],
    ['the open panel is another one', [standingPanel(() => SHOWN), devCommand()], '/optimize'],
  ] as const)('shouldSendTheMessageAloneWhen%s', async (_case, commands, open) => {
    const { controller, prompts } = chat(commands)
    if (open) await controller.submit(open)

    await controller.submit('approve this')

    expect(prompts).toEqual(['approve this'])
  })

  it('shouldNotAddItToACommandThatBringsItsOwnRequest', async () => {
    const activate = vi.fn(async () => ({
      skill: { name: 'strands-evals', description: 'Evals', instructions: 'Use evals.', active: true },
      content: 'Use evals.',
    }))
    const { controller, prompts } = chat([standingPanel(() => SHOWN), skillCommand()], {
      skills: { list: async () => [], activate },
    })
    await controller.submit('/ask')

    await controller.submit('/evaluate refunds')

    expect(prompts).toHaveLength(1)
    expect(String(prompts[0])).not.toContain('<strands_dev_screen>')
    expect(String(prompts[0]).endsWith('\n\n/evaluate refunds')).toBe(true)
  })
})

describe('what a dev command hears and can change', () => {
  const replying = (fail = false) =>
    idleBackend({
      async *stream() {
        if (fail) throw new Error('The model did not answer.')
        yield { type: 'textDelta', text: 'done' } as const
        return { stopReason: 'endTurn' }
      },
    })

  const listening = (): { command: DevChatCommand; heard: string[]; contexts: DevChatCommandContext[] } => {
    const heard: string[] = []
    const contexts: DevChatCommandContext[] = []
    const command: DevChatCommand = {
      ...devCommand(),
      turnEnded: (context, { prompt }) => {
        contexts.push(context)
        heard.push(prompt)
      },
    }
    return { command, heard, contexts }
  }

  it('shouldTellACommandOfEachTurnOfTheDeveloperThatEndedWithAReply', async () => {
    const { command, heard } = listening()
    const controller = new ChatController(replying(), { devCommands: [command] })

    await controller.submit('first message')
    await controller.submit('second message')

    expect(heard).toEqual(['first message', 'second message'])
  })

  it('shouldNotTellACommandOfATurnThatFailed', async () => {
    const { command, heard } = listening()
    const controller = new ChatController(replying(true), { devCommands: [command] })

    await controller.submit('a message the model does not answer')

    expect(heard).toEqual([])
  })

  it('shouldKeepTheChatGoingWhenACommandFailsOnTheEndOfATurn', async () => {
    const failing: DevChatCommand = {
      ...devCommand(),
      turnEnded: () => {
        throw new Error('the command broke')
      },
    }
    const controller = new ChatController(replying(), { devCommands: [failing] })

    await controller.submit('first message')
    await controller.submit('second message')

    expect(controller.getSnapshot().completedTurns.map(({ prompt, status }) => [prompt, status])).toEqual([
      ['first message', 'complete'],
      ['second message', 'complete'],
    ])
  })

  it('shouldLetACommandSendARequestWhenATurnEndsWhichThenRunsAsATurn', async () => {
    const sent: unknown[] = []
    const command: DevChatCommand = {
      ...devCommand(),
      turnEnded: (context, { prompt }) => {
        if (prompt === 'the turn that makes it due') context.submit('sent by the command')
      },
    }
    const controller = new ChatController(
      idleBackend({
        async *stream(prompt) {
          sent.push(prompt)
          yield { type: 'textDelta', text: 'done' } as const
          return { stopReason: 'endTurn' }
        },
      }),
      { devCommands: [command] }
    )

    await controller.submit('the turn that makes it due')

    await vi.waitFor(() => expect(sent).toEqual(['the turn that makes it due', 'sent by the command']))
  })

  it('shouldLetACommandChangeASettingAsTheSettingsPanelDoes', async () => {
    const { command, contexts } = listening()
    const setSettings = vi.fn(async () => undefined)
    const controller = new ChatController(replying(), { devCommands: [command], setSettings })
    await controller.submit('a message')

    const saved = await contexts[0]!.setSettings?.({ autoOptimize: 20 })

    expect(saved).toBe(true)
    expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoOptimize: 20 })
    expect(controller.getSnapshot().settings.autoOptimize).toBe(20)
  })
})
