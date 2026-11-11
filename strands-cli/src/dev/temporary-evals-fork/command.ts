import type { ImportedAgentProject } from '../../project/import.js'
import { errorMessage } from '../../terminal/text.js'
import type { ChatNotice, DevChatCommand, DevChatCommandContext, DevChatNotice } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import {
  createTemporaryExperiment,
  TEMPORARY_EXPERIMENT_EXAMPLE,
  TEMPORARY_EXPERIMENT_USAGE,
  type TemporaryExperimentDependencies,
} from './experiment.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'

interface OptimizeRequest {
  experiment?: string
  forkArguments: string[]
}

interface ExperimentRequest {
  name: string
  description: string
  forkArguments: string[]
}

interface ActiveOptimization {
  status: ChatNotice['status']
  text: string
  views: DevChatNotice[]
}

const USAGE = '/optimize [experiment] [-- strands-evals optimize flags]'
const OPTIMIZE_EXAMPLE = '/optimize refunds -- --iterations 2'
const HEADER_PREFIXES = ['Optimizing ', 'Record: ']

let active: ActiveOptimization | undefined

const splitArgument = (argument: string): { own: string[]; forkArguments: string[] } => {
  const tokens = argument.split(/\s+/u).filter(Boolean)
  const separator = tokens.indexOf('--')
  return separator < 0
    ? { own: tokens, forkArguments: [] }
    : { own: tokens.slice(0, separator), forkArguments: tokens.slice(separator + 1) }
}

const parseOptimizeArgument = (argument: string): OptimizeRequest => {
  const { own, forkArguments } = splitArgument(argument)
  if (own.length > 1)
    throw new Error(`Give at most one experiment name before --. Usage: ${USAGE}. Example: ${OPTIMIZE_EXAMPLE}`)
  return { ...(own[0] ? { experiment: own[0] } : {}), forkArguments }
}

const parseExperimentArgument = (argument: string): ExperimentRequest => {
  const { own, forkArguments } = splitArgument(argument)
  const [name = '', ...description] = own
  return { name, description: description.join(' '), forkArguments }
}

const targetWorkspace = (workspace: DevWorkspace, project: ImportedAgentProject): DevWorkspace => ({
  ...workspace,
  root: project.root,
  entrypoint: project.entrypoint,
  config: { ...workspace.config, language: project.language },
})

const show = (run: ActiveOptimization, context: DevChatCommandContext): void => {
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

const broadcast = (run: ActiveOptimization, status: ChatNotice['status'], text: string): void => {
  run.status = status
  run.text = text
  for (const view of run.views) view.update(status, text)
}

const optimize = async (
  workspace: DevWorkspace,
  request: OptimizeRequest,
  run: ActiveOptimization,
  dependencies: TemporaryOptimizationDependencies
): Promise<void> => {
  const header: string[] = []
  let latest = 'Preparing the optimizer'
  const progress = (): string => ['TEMPORARY optimization', ...header, latest].join('\n')
  try {
    const outcome = await runTemporaryOptimization(
      {
        workspace,
        ...request,
        onProgress: (line) => {
          if (HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) header.push(line)
          else latest = line
          broadcast(run, 'running', progress())
        },
      },
      dependencies
    )
    broadcast(run, 'success', ['TEMPORARY optimization finished', ...outcome.summary].join('\n'))
  } catch (error) {
    broadcast(run, 'error', `TEMPORARY optimization failed\n${errorMessage(error)}`)
  }
}

export const temporaryOptimizeCommand = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  dependencies: TemporaryOptimizationDependencies = {}
): DevChatCommand => {
  const target = targetWorkspace(workspace, project)
  return {
    spec: {
      name: 'optimize',
      usage: USAGE,
      description: 'TEMPORARY: tune this agent against an experiment in strands-dev/tmp/experiments',
    },
    run: (argument, context): void => {
      if (active) {
        context.fail(
          'Optimization running',
          'An optimization is already running, and its progress is in the notice above. Wait for it to finish, then try again.'
        )
        return
      }
      let request: OptimizeRequest
      try {
        request = parseOptimizeArgument(argument)
      } catch (error) {
        context.fail('Invalid /optimize arguments', errorMessage(error))
        return
      }
      const run: ActiveOptimization = { status: 'running', text: 'TEMPORARY optimization\nPreparing', views: [] }
      active = run
      show(run, context)
      void optimize(target, request, run, dependencies).finally(() => {
        active = undefined
      })
    },
    attach: (context): void => {
      if (active) show(active, context)
    },
  }
}

const createExperiment = async (
  workspace: DevWorkspace,
  request: ExperimentRequest,
  context: DevChatCommandContext,
  dependencies: TemporaryExperimentDependencies
): Promise<void> => {
  const title = `TEMPORARY experiment ${request.name}`
  const notice = context.report('running', `${title}\nPreparing the generator`)
  try {
    const outcome = await createTemporaryExperiment(
      { workspace, ...request, onProgress: (line) => notice.update('running', `${title}\n${line}`) },
      dependencies
    )
    notice.update(
      'success',
      `${title} saved\n${outcome.cases} cases in ${outcome.path}\n` +
        `Review or edit the cases there, then run /optimize ${request.name}.`
    )
  } catch (error) {
    notice.update('error', `${title} failed\n${errorMessage(error)}`)
  }
}

export const temporaryExperimentCommand = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  dependencies: TemporaryExperimentDependencies = {}
): DevChatCommand => {
  const target = targetWorkspace(workspace, project)
  return {
    spec: {
      name: 'experiment',
      usage: TEMPORARY_EXPERIMENT_USAGE,
      description: 'TEMPORARY: generate test cases for this agent in strands-dev/tmp/experiments',
    },
    run: (argument, context): void => {
      const request = parseExperimentArgument(argument)
      if (!request.name) {
        context.fail(
          'Experiment name missing',
          `Name the experiment and say what the agent does. Usage: ${TEMPORARY_EXPERIMENT_USAGE}. ` +
            `Example: ${TEMPORARY_EXPERIMENT_EXAMPLE}`
        )
        return
      }
      void createExperiment(target, request, context, dependencies)
    },
  }
}

export const temporaryDevCommands = (workspace: DevWorkspace, project: ImportedAgentProject): DevChatCommand[] => [
  temporaryExperimentCommand(workspace, project),
  temporaryOptimizeCommand(workspace, project),
]
