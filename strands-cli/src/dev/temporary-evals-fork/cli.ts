import { basename } from 'node:path'

import type { ParsedArgs } from '../../cli/arguments.js'
import { errorMessage } from '../../terminal/text.js'
import type { PreparedDevRun } from '../prepare.js'
import type { DevWorkspace } from '../workspace.js'
import { runTemporaryOptimization, type TemporaryOptimizationDependencies } from './optimize.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { temporaryWorkspaceReady } from './layout-migration.js'
import { readTemporaryTestResults, rememberTemporaryTestResults } from './report.js'
import { runTemporaryTest, type TemporaryTestDependencies, type TemporaryTestOutcome } from './test.js'

export interface TemporaryDevCommandDependencies extends TemporaryOptimizationDependencies, TemporaryTestDependencies {
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
  forkArguments: string[]
  onProgress: (line: string) => void
  prepare: () => Promise<void>
}

export const temporaryTestSummary = (outcome: TemporaryTestOutcome, optimize: string): string[] => [
  `${outcome.passed} of ${outcome.checks} checks passed (overall score ${outcome.overall.toFixed(2)})`,
  `Report: ${outcome.report}`,
  outcome.passed < outcome.checks
    ? `The report gives each failing check its reason. Run ${optimize} ${outcome.name} to improve the agent on them.`
    : 'Every check passed.',
]

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
  dependencies: TemporaryDevCommandDependencies
): Promise<{ lines: string[]; code: number }> => {
  const { summary, proposerFailure } = await runTemporaryOptimization(shared, dependencies)
  if (proposerFailure) shared.onProgress(`error: ${proposerFailure}`)
  return { lines: summary, code: proposerFailure ? 1 : 0 }
}

const rememberTest = async (
  { home, report, seconds }: TemporaryTestOutcome,
  warn: (line: string) => void
): Promise<void> => {
  try {
    await rememberTemporaryTestResults(
      home,
      await readTemporaryTestResults(report, { experiment: basename(home), seconds })
    )
  } catch (error) {
    warn(`warning: this result is not kept as the latest report: ${errorMessage(error)}`)
  }
}

const evaluate = async (
  shared: Shared,
  dependencies: TemporaryDevCommandDependencies
): Promise<{ lines: string[]; code: number }> => {
  const outcome = await runTemporaryTest(shared, dependencies)
  await rememberTest(outcome, shared.onProgress)
  const workspace = shared.workspaceOption ? ` --workspace ${shared.workspaceOption}` : ''
  return {
    lines: temporaryTestSummary(outcome, `strands dev optimize${workspace}`),
    code: outcome.passed < outcome.checks ? 1 : 0,
  }
}

const RUNNERS = { optimize, evaluate }

export const runTemporaryDevCommand = async (
  args: ParsedArgs,
  output: Output = process,
  dependencies: TemporaryDevCommandDependencies = {}
): Promise<number> => {
  const request = args.dev?.temporaryCommand
  if (!request) return 1
  const { openWorkspace: open = openWorkspace, prepareProject: prepare = prepareProject, ...runner } = dependencies
  try {
    const opened = await open(args)
    if (!opened) return 1
    const { problems } = await temporaryWorkspaceReady(temporaryWorkspaceDirectory(opened.workspace))
    problems.forEach((problem) =>
      output.stderr.write(`warning: could not move to the new workspace layout: ${problem}\n`)
    )
    const { lines, code } = await RUNNERS[request.name](
      {
        workspace: opened.workspace,
        ...(args.dev?.workspace ? { workspaceOption: args.dev.workspace } : {}),
        ...(request.experiment ? { experiment: request.experiment } : {}),
        forkArguments: request.forkArguments,
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
