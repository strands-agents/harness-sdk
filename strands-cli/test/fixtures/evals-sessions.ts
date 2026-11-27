import { join } from 'node:path'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { vi } from 'vitest'
import type { ExperimentSummary } from '../../src/dev/evals/model.js'
import { evalsVenvPython } from '../../src/dev/evals/runs/environment.js'
import type { EvalsSessionDependencies } from '../../src/dev/evals/host.js'
import type { EvalsSessionHost } from '../../src/dev/evals/host.js'
import { evalsDevSessions } from '../../src/dev/evals/sessions/sessions.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'
import type { ChatNotice, DevChatCommandContext } from '../../src/ui/chat/types.js'
import { temporaryDirectory } from './tempdir.js'
import { environmentRunner, writeFileAt } from './optimizer-run.js'

export const BASELINE = 'Answer in one word.'

export const workspaceFixture = async (): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFileAt(evalsVenvPython(join(root, '.venv')), 'fixture interpreter')
  await writeFileAt(join(root, 'instructions.md'), `${BASELINE}\n`)
  await writeFileAt(
    join(root, 'agent.py'),
    'agent = create_harness(instructions=open("instructions.md").read(), effort="low")\n'
  )
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

export const experimentDocument = (names: readonly string[], evaluators: readonly string[] = ['OutputEvaluator']) => ({
  cases: names.map((name) => ({
    name,
    session_id: `session-${name}`,
    input: `question ${name}`,
    expected_output: `answer ${name}`,
    metadata: null,
  })),
  evaluators: evaluators.map((evaluator_type) => ({ evaluator_type })),
})

export const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

export const exit = { code: 0, stdout: '', stderrTail: [] }

export const held = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export const chat = () => {
  const notices: { status: ChatNotice['status']; text: string }[] = []
  const context: DevChatCommandContext = {
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
    openPanel: vi.fn(() => true),
  }
  return { context, notices }
}

export const sessionsFor = async (
  dependencies: Partial<EvalsSessionDependencies> = {},
  settings: Pick<EvalsSessionHost, 'settings'> = {}
) => {
  const workspace = await workspaceFixture()
  const { context, notices } = chat()
  const sessions = evalsDevSessions({
    workspace,
    agent: () => ({ description: 'Answers capital city questions', tools: [] }),
    context,
    dependencies: {
      run: environmentRunner(),
      harnessDefaults: async () => ({ options: { ...DEFAULT_HARNESS_AGENT_CONFIG }, webSearch: false }),
      ...dependencies,
    },
    ...settings,
  })
  return { workspace, sessions, notices }
}

export const experimentHome = (workspace: DevWorkspace, name = 'capital'): string =>
  join(workspace.directory!, 'experiments', name)

export const experimentFile = (workspace: DevWorkspace, name: string): string =>
  join(experimentHome(workspace, name), `${name}.json`)

export const savedExperiment = async (
  workspace: DevWorkspace,
  names: readonly string[],
  name = 'capital',
  evaluators?: readonly string[]
): Promise<ExperimentSummary> => {
  const path = experimentFile(workspace, name)
  await writeFileAt(path, JSON.stringify(experimentDocument(names, evaluators)))
  return { name, path, caseCount: names.length }
}

export const finished = (sessions: ReturnType<typeof evalsDevSessions>, path: string) => {
  const run = sessions.evaluate.snapshot().runs.find(({ experiment }) => experiment.path === path)?.run
  if (run?.status !== 'done') throw new Error(`expected finished results, got ${run?.status}`)
  return run.results
}

export const restartedHost =
  (workspace: DevWorkspace, dependencies?: Partial<EvalsSessionDependencies>) => (): EvalsSessionHost => ({
    workspace,
    agent: () => ({}),
    ...(dependencies ? { dependencies } : {}),
  })
