import type { ImportedAgentProject } from '../../project/import.js'
import { errorMessage } from '../../terminal/text.js'
import type { LocalCommandSpec } from '../../ui/chat/commands.js'
import type { ChatNotice, DevChatCommand, DevChatCommandContext, DevChatNotice } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import {
  createTemporaryExperiment,
  TEMPORARY_EXPERIMENT_EXAMPLE,
  TEMPORARY_EXPERIMENT_USAGE,
  type TemporaryExperimentDependencies,
} from './experiment.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'
import { runTemporaryTest, type TemporaryTestDependencies, type TemporaryTestOutcome } from './test.js'

interface ExperimentRun {
  experiment?: string
  forkArguments: string[]
}

interface ExperimentRequest {
  name: string
  description: string
  forkArguments: string[]
}

interface BackgroundRun {
  status: ChatNotice['status']
  text: string
  views: DevChatNotice[]
}

interface BackgroundCommand<Request> {
  spec: LocalCommandSpec
  title: (request: Request) => string
  done: string
  busy: string
  parse: (argument: string) => Request
  execute: (request: Request, onProgress: (line: string) => void) => Promise<string[]>
}

const HEADER_PREFIXES = ['Optimizing ', 'Record: ', 'Testing ', 'Report: ']
const OPTIMIZE_USAGE = '/optimize [experiment] [-- strands-evals optimize flags]'
const TEST_USAGE = '/test [experiment] [-- strands-evals run flags]'

const runs = new Map<string, BackgroundRun>()

const splitArgument = (argument: string): { own: string[]; forkArguments: string[] } => {
  const tokens = argument.split(/\s+/u).filter(Boolean)
  const separator = tokens.indexOf('--')
  return separator < 0
    ? { own: tokens, forkArguments: [] }
    : { own: tokens.slice(0, separator), forkArguments: tokens.slice(separator + 1) }
}

const parseExperimentRun =
  (usage: string, example: string) =>
  (argument: string): ExperimentRun => {
    const { own, forkArguments } = splitArgument(argument)
    if (own.length > 1)
      throw new Error(`Give at most one experiment name before --. Usage: ${usage}. Example: ${example}`)
    return { ...(own[0] ? { experiment: own[0] } : {}), forkArguments }
  }

const parseExperimentRequest = (argument: string): ExperimentRequest => {
  const { own, forkArguments } = splitArgument(argument)
  const [name = '', ...description] = own
  if (!name)
    throw new Error(
      `Name the experiment and say what the agent does. Usage: ${TEMPORARY_EXPERIMENT_USAGE}. ` +
        `Example: ${TEMPORARY_EXPERIMENT_EXAMPLE}`
    )
  return { name, description: description.join(' '), forkArguments }
}

const targetWorkspace = (workspace: DevWorkspace, project: ImportedAgentProject): DevWorkspace => ({
  ...workspace,
  root: project.root,
  entrypoint: project.entrypoint,
  config: { ...workspace.config, language: project.language },
})

const show = (run: BackgroundRun, context: DevChatCommandContext): void => {
  const view = context.report(run.status, run.text)
  run.views.push(view)
  context.signal.addEventListener(
    'abort',
    () => {
      run.views = run.views.filter((candidate) => candidate !== view)
    },
    { once: true }
  )
}

const broadcast = (run: BackgroundRun, status: ChatNotice['status'], text: string): void => {
  run.status = status
  run.text = text
  for (const view of run.views) view.update(status, text)
}

const progressText = (title: string): ((line: string) => string) => {
  const header: string[] = []
  let latest = ''
  return (line) => {
    if (HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) header.push(line)
    else latest = line
    return [title, ...header, latest].filter(Boolean).join('\n')
  }
}

const backgroundCommand = <Request>(definition: BackgroundCommand<Request>): DevChatCommand => ({
  spec: definition.spec,
  run: (argument, context): void => {
    if (runs.has(definition.spec.name)) {
      context.fail(`/${definition.spec.name} is running`, definition.busy)
      return
    }
    let request: Request
    try {
      request = definition.parse(argument)
    } catch (error) {
      context.fail(`Invalid /${definition.spec.name} arguments`, errorMessage(error))
      return
    }
    const title = definition.title(request)
    const run: BackgroundRun = { status: 'running', text: `${title}\nPreparing`, views: [] }
    runs.set(definition.spec.name, run)
    show(run, context)
    const progress = progressText(title)
    void definition
      .execute(request, (line) => broadcast(run, 'running', progress(line)))
      .then((lines) => broadcast(run, 'success', [`${title} ${definition.done}`, ...lines].join('\n')))
      .catch((error: unknown) => broadcast(run, 'error', `${title} failed\n${errorMessage(error)}`))
      .finally(() => runs.delete(definition.spec.name))
  },
  attach: (context): void => {
    const run = runs.get(definition.spec.name)
    if (run) show(run, context)
  },
})

const busyText = (work: string): string =>
  `${work} is already running, and its progress is in the notice above. Wait for it to finish, then try again.`

export const temporaryOptimizeCommand = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  dependencies: TemporaryOptimizationDependencies = {}
): DevChatCommand =>
  backgroundCommand({
    spec: {
      name: 'optimize',
      usage: OPTIMIZE_USAGE,
      description: 'TEMPORARY: tune this agent against an experiment in strands-dev/tmp/experiments',
    },
    title: () => 'TEMPORARY optimization',
    done: 'finished',
    busy: busyText('An optimization'),
    parse: parseExperimentRun(OPTIMIZE_USAGE, '/optimize refunds -- --iterations 2'),
    execute: async (request, onProgress) =>
      (
        await runTemporaryOptimization(
          { workspace: targetWorkspace(workspace, project), ...request, onProgress },
          dependencies
        )
      ).summary,
  })

export const temporaryTestSummary = (outcome: TemporaryTestOutcome, optimize: string): string[] => [
  `${outcome.passed} of ${outcome.checks} checks passed (overall score ${outcome.overall.toFixed(2)})`,
  `Report: ${outcome.report}`,
  outcome.passed < outcome.checks
    ? `The report gives each failing check its reason. Run ${optimize} ${outcome.name} to improve the agent on them.`
    : 'Every check passed.',
]

export const temporaryTestCommand = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  dependencies: TemporaryTestDependencies = {}
): DevChatCommand =>
  backgroundCommand({
    spec: {
      name: 'test',
      usage: TEST_USAGE,
      description: 'TEMPORARY: run this agent on an experiment in strands-dev/tmp/experiments and save a report',
    },
    title: () => 'TEMPORARY test',
    done: 'finished',
    busy: busyText('A test'),
    parse: parseExperimentRun(TEST_USAGE, '/test refunds'),
    execute: async (request, onProgress) =>
      temporaryTestSummary(
        await runTemporaryTest(
          { workspace: targetWorkspace(workspace, project), ...request, onProgress },
          dependencies
        ),
        '/optimize'
      ),
  })

export const temporaryExperimentCommand = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  dependencies: TemporaryExperimentDependencies = {}
): DevChatCommand =>
  backgroundCommand({
    spec: {
      name: 'experiment',
      usage: TEMPORARY_EXPERIMENT_USAGE,
      description: 'TEMPORARY: generate test cases for this agent in strands-dev/tmp/experiments',
    },
    title: (request) => `TEMPORARY experiment ${request.name}`,
    done: 'saved',
    busy: busyText('An experiment generation'),
    parse: parseExperimentRequest,
    execute: async (request, onProgress) => {
      const outcome = await createTemporaryExperiment(
        { workspace: targetWorkspace(workspace, project), ...request, onProgress },
        dependencies
      )
      return [
        `${outcome.cases} cases in ${outcome.path}`,
        `Review or edit the cases there, then run /test ${request.name} or /optimize ${request.name}.`,
      ]
    },
  })

export const temporaryDevCommands = (workspace: DevWorkspace, project: ImportedAgentProject): DevChatCommand[] => [
  temporaryExperimentCommand(workspace, project),
  temporaryTestCommand(workspace, project),
  temporaryOptimizeCommand(workspace, project),
]
