import { basename } from 'node:path'

import type { ParsedArgs } from '../../cli/arguments.js'
import { errorMessage } from '../../terminal/text.js'
import type { PreparedDevRun } from '../prepare.js'
import type { DevWorkspace } from '../workspace.js'
import { runEvalsOptimization, type EvalsOptimizationDependencies } from './optimize.js'
import { evalsWorkspaceDirectory } from './evals-process.js'
import { evalsWorkspaceReady } from './layout-migration.js'
import { readEvalsTestResults, rememberEvalsTestResults, runEvalsTest, type EvalsTestDependencies } from './test.js'

interface EvalsDevCommandDependencies extends EvalsOptimizationDependencies, EvalsTestDependencies {
  openWorkspace?: (args: ParsedArgs) => Promise<PreparedDevRun | undefined>
  prepareProject?: (workspace: DevWorkspace) => Promise<void>
}

interface Output {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

interface Shared {
  workspace: DevWorkspace
  workspaceOption?: string
  experiment?: string
  evalsArguments: string[]
  onProgress: (line: string) => void
  prepare: () => Promise<void>
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

const optimize = async (
  shared: Shared,
  dependencies: EvalsDevCommandDependencies
): Promise<{ lines: string[]; code: number }> => {
  const { summary, proposerFailure } = await runEvalsOptimization(shared, dependencies)
  if (proposerFailure) shared.onProgress(`error: ${proposerFailure}`)
  return { lines: summary, code: proposerFailure ? 1 : 0 }
}

const evaluate = async (
  shared: Shared,
  dependencies: EvalsDevCommandDependencies
): Promise<{ lines: string[]; code: number }> => {
  const { home, report, seconds, passed, checks, overall, name } = await runEvalsTest(shared, dependencies)
  try {
    await rememberEvalsTestResults(home, await readEvalsTestResults(report, { experiment: basename(home), seconds }))
  } catch (error) {
    shared.onProgress(`warning: this result is not kept as the latest report: ${errorMessage(error)}`)
  }
  const workspace = shared.workspaceOption ? ` --workspace ${shared.workspaceOption}` : ''
  return {
    lines: [
      `${passed} of ${checks} checks passed (overall score ${overall.toFixed(2)})`,
      `Report: ${report}`,
      passed < checks
        ? `The report gives each failing check its reason. Run strands dev optimize${workspace} ${name} to improve the agent on them.`
        : 'Every check passed.',
    ],
    code: passed < checks ? 1 : 0,
  }
}

const RUNNERS = { optimize, evaluate }

export const runEvalsDevCommand = async (
  args: ParsedArgs,
  output: Output = process,
  dependencies: EvalsDevCommandDependencies = {}
): Promise<number> => {
  const request = args.dev?.evalsCommand
  if (!request) return 1
  const { openWorkspace: open = openWorkspace, prepareProject: prepare = prepareProject, ...runner } = dependencies
  try {
    const opened = await open(args)
    if (!opened) return 1
    const { problems } = await evalsWorkspaceReady(evalsWorkspaceDirectory(opened.workspace))
    problems.forEach((problem) =>
      output.stderr.write(`warning: could not move to the new workspace layout: ${problem}\n`)
    )
    const { lines, code } = await RUNNERS[request.name](
      {
        workspace: opened.workspace,
        ...(args.dev?.workspace ? { workspaceOption: args.dev.workspace } : {}),
        ...(request.experiment ? { experiment: request.experiment } : {}),
        evalsArguments: request.evalsArguments,
        onProgress: (line) => output.stderr.write(`${line}\n`),
        prepare: async () => {
          await prepare(opened.workspace)
          opened.config.applyProviderEnvironment()
        },
      },
      runner
    )
    output.stdout.write(`${lines.join('\n')}\n`)
    return code
  } catch (error) {
    output.stderr.write(`error: ${errorMessage(error)}\n`)
    return 1
  }
}
