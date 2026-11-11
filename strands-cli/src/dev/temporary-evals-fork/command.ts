import type { ImportedAgentProject } from '../../project/import.js'
import { errorMessage } from '../../terminal/text.js'
import type { ChatNotice, DevChatCommand, DevChatCommandContext, DevChatNotice } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'

interface OptimizeRequest {
  experiment?: string
  forkArguments: string[]
}

interface ActiveOptimization {
  status: ChatNotice['status']
  text: string
  views: DevChatNotice[]
}

const USAGE = '/optimize [experiment] [-- strands-evals optimize flags]'
const HEADER_PREFIXES = ['Optimizing ', 'Record: ']

let active: ActiveOptimization | undefined

const parseOptimizeArgument = (argument: string): OptimizeRequest => {
  const tokens = argument.split(/\s+/u).filter(Boolean)
  const separator = tokens.indexOf('--')
  const own = separator < 0 ? tokens : tokens.slice(0, separator)
  if (own.length > 1) throw new Error(`Usage: ${USAGE}`)
  return { ...(own[0] ? { experiment: own[0] } : {}), forkArguments: separator < 0 ? [] : tokens.slice(separator + 1) }
}

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
  const target: DevWorkspace = {
    ...workspace,
    root: project.root,
    entrypoint: project.entrypoint,
    config: { ...workspace.config, language: project.language },
  }
  return {
    spec: {
      name: 'optimize',
      usage: USAGE,
      description: 'TEMPORARY: tune this agent against an experiment in strands-dev/tmp/experiments',
    },
    run: (argument, context): void => {
      if (active) {
        context.fail('Optimization running', 'Wait for the current optimization to finish.')
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
