import type { ParsedArgs } from '../../cli/arguments.js'
import { errorMessage } from '../../terminal/text.js'
import type { PreparedDevRun } from '../prepare.js'
import type { DevWorkspace } from '../workspace.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'

export interface TemporaryDevOptimizeDependencies extends TemporaryOptimizationDependencies {
  openWorkspace?: (args: ParsedArgs) => Promise<PreparedDevRun | undefined>
  prepareProject?: (workspace: DevWorkspace) => Promise<void>
}

interface Output {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

const openWorkspace = async (args: ParsedArgs): Promise<PreparedDevRun | undefined> => {
  const { prepareDevRun } = await import('../prepare.js')
  return prepareDevRun(args, { deferPreparation: true })
}

const prepareProject = async (workspace: DevWorkspace): Promise<void> => {
  const { planProjectPreparation } = await import('../../project/preparation-plan.js')
  const { executePreparation } = await import('../../project/preparation.js')
  await executePreparation(
    await planProjectPreparation({
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: workspace.config.language,
    })
  )
}

export const runTemporaryDevOptimize = async (
  args: ParsedArgs,
  output: Output = process,
  dependencies: TemporaryDevOptimizeDependencies = {}
): Promise<number> => {
  const request = args.dev?.temporaryOptimize
  if (!request) return 1
  const { openWorkspace: open = openWorkspace, prepareProject: prepare = prepareProject, ...optimizer } = dependencies
  try {
    const opened = await open(args)
    if (!opened) return 1
    const outcome = await runTemporaryOptimization(
      {
        workspace: opened.workspace,
        ...(request.experiment ? { experiment: request.experiment } : {}),
        forkArguments: request.forkArguments,
        onProgress: (line) => output.stderr.write(`${line}\n`),
        prepare: async () => {
          await prepare(opened.workspace)
          opened.config.applyProviderEnvironment()
        },
      },
      optimizer
    )
    output.stdout.write(`${outcome.summary.join('\n')}\n`)
    return 0
  } catch (error) {
    output.stderr.write(`error: ${errorMessage(error)}\n`)
    return 1
  }
}
