import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { autoOptimizeRun } from '../../../src/dev/temporary-evals-fork/auto-optimize-run.js'
import type {
  AutoOptimizeWorker,
  AutoOptimizeWorkerRequest,
} from '../../../src/dev/temporary-evals-fork/auto-optimize-worker.js'
import type { UnattendedConversion } from '../../../src/dev/temporary-evals-fork/session-converter.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date(2026, 10, 23, 15, 2)
const NAME = 'history-20261123-1502'

const experimentWith = (cases: number): string =>
  JSON.stringify({
    cases: Array.from({ length: cases }, (_, index) => ({ name: `c${index}`, input: 'hi', expected_assertion: 'ok' })),
    evaluators: [{ evaluator_type: 'OutputEvaluator' }],
  })

/** The background work with an agent that the test plays: it saves the cases it is told to, or none. */
const setup = async (made: { cases?: number; code?: number } = { cases: 5 }) => {
  const root = await temporaryDirectory()
  const workspace: DevWorkspace = {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.ts'),
    config: {
      version: 1,
      name: 'desk',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'discovered' },
    },
  }
  const file = (name: string): string => join(root, 'strands-dev', 'experiments', name, `${name}.json`)
  const order: string[] = []
  const requests: AutoOptimizeWorkerRequest[] = []
  const worker = vi.fn<AutoOptimizeWorker>(async (request) => {
    order.push('agent')
    requests.push(request)
    const name = /save it as (\S+)/u.exec(request.prompt)![1]!
    if (made.cases !== undefined) {
      await mkdir(dirname(file(name)), { recursive: true })
      await writeFile(file(name), experimentWith(made.cases))
    }
    return { code: made.code ?? 0 }
  })
  const unattendedConverter = vi.fn(async ({ name }: UnattendedConversion) => `the skill: save it as ${name}`)
  const start = vi.fn(async (_experiment: string) => {
    order.push('optimizer')
    return 'run-1'
  })
  const idle = vi.fn(async (): Promise<void> => {
    order.push('idle')
  })
  const building = vi.fn()
  const stop = new AbortController()
  const run = autoOptimizeRun({
    workspace,
    history: { unattendedConverter },
    start,
    worker,
    now: () => NOW,
  })
  const go = () => run({ signal: stop.signal, building, idle })
  return { root, file, worker, requests, unattendedConverter, start, idle, building, stop, order, go }
}

describe('what auto-optimize does in the background when it is due', () => {
  it('shouldHaveAnAgentMakeTheExperimentAndThenStartTheOptimizerItself', async () => {
    const { go, order, start } = await setup({ cases: 5 })

    const outcome = await go()

    expect(outcome).toEqual({ experiment: NAME, cases: 5 })
    // The optimizer is started by strands dev and not by the agent: no model decides whether a paid run may begin.
    expect(order).toEqual(['agent', 'idle', 'optimizer'])
    expect(start).toHaveBeenCalledExactlyOnceWith(NAME)
  })

  it('shouldGiveTheAgentTheSkillForItsExperimentWhenItStarts', async () => {
    const { go, requests, unattendedConverter, root } = await setup()

    await go()

    expect(unattendedConverter).toHaveBeenCalledExactlyOnceWith({ name: NAME, fewestCases: 3 })
    expect(requests[0]!.prompt).toContain('strands dev runs you in the background')
    expect(requests[0]!.prompt).toContain('strands dev starts the optimization itself')
    expect(requests[0]!.prompt.endsWith(`the skill: save it as ${NAME}`)).toBe(true)
    expect(requests[0]!.log).toBe(join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', `${NAME}.log`))
  })

  it('shouldNameTheExperimentAndItsLogBeforeTheAgentStarts', async () => {
    const { go, building, worker, root } = await setup()

    await go()

    expect(building).toHaveBeenCalledExactlyOnceWith(
      NAME,
      join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', `${NAME}.log`)
    )
    expect(building.mock.invocationCallOrder[0]).toBeLessThan(worker.mock.invocationCallOrder[0]!)
  })

  it('shouldTakeANameThatNoExperimentHasWhenOneWasMadeInTheSameMinute', async () => {
    const { go, file } = await setup()
    await mkdir(dirname(file(NAME)), { recursive: true })

    const outcome = await go()

    expect(outcome.experiment).toBe(`${NAME}-2`)
  })

  it('shouldStartNoOptimizerWhenTheChatsGaveTooFewCases', async () => {
    const { go, start } = await setup({ cases: 2 })

    await expect(go()).rejects.toThrow(`${NAME} has 2 of the 3 cases an optimization needs`)
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldPointAtTheLogWhenTheAgentSavedNoExperiment', async () => {
    const { go, start, root } = await setup({})
    const log = join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', `${NAME}.log`)

    await expect(go()).rejects.toThrow(`the chats gave no experiment · the agent's reasons are in ${log}`)
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldGiveTheExitCodeWhenTheAgentFailedBeforeItSavedAnything', async () => {
    const { go, root } = await setup({ code: 1 })
    const log = join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', `${NAME}.log`)

    await expect(go()).rejects.toThrow(`the agent that makes the experiment stopped with code 1 · see ${log}`)
  })

  it('shouldStartNoOptimizerWhenItWasStoppedWhileTheAgentWorked', async () => {
    const { go, stop, start, worker } = await setup()
    worker.mockImplementationOnce(async () => {
      stop.abort()
      return { code: 143 }
    })

    await expect(go()).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldWaitForAnOptimizationThatTheDeveloperStartedMeanwhileBeforeItStartsItsOwn', async () => {
    const { go, idle, start } = await setup()
    let free!: () => void
    idle.mockImplementationOnce(() => new Promise<void>((resolve) => (free = (): void => resolve())))

    const going = go()
    await vi.waitFor(() => expect(idle).toHaveBeenCalled())
    const whileTheOtherRuns = start.mock.calls.length
    free()
    await going

    expect(whileTheOtherRuns).toBe(0)
    expect(start).toHaveBeenCalledOnce()
  })
})
