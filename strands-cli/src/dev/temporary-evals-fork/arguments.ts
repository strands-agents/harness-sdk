import { Command } from 'commander'

export type TemporaryDevCommandName = 'optimize' | 'test'

export interface TemporaryDevCommandArguments {
  name: TemporaryDevCommandName
  experiment?: string
  workspace?: string
  forkArguments: string[]
}

const DESCRIPTIONS: Record<TemporaryDevCommandName, string> = {
  optimize:
    'TEMPORARY: tune the dev workspace agent against an experiment in strands-dev/tmp/experiments with the ' +
    'strands-evals optimize command from the evals fork. Flags after -- go to strands-evals optimize.',
  test:
    'TEMPORARY: run the dev workspace agent on an experiment in strands-dev/tmp/experiments with strands-evals run ' +
    'from the evals fork, and save the report in strands-dev/tmp/reports. Flags after -- go to strands-evals run.',
}

export const isTemporaryDevCommand = (name: string | undefined): name is TemporaryDevCommandName =>
  name === 'optimize' || name === 'test'

export const parseTemporaryDevCommandArguments = (
  name: TemporaryDevCommandName,
  argv: string[]
): TemporaryDevCommandArguments => {
  const separator = argv.indexOf('--')
  const own = separator < 0 ? argv : argv.slice(0, separator)
  const forkArguments = separator < 0 ? [] : argv.slice(separator + 1)
  const program = new Command()
    .name(`strands dev ${name}`)
    .description(DESCRIPTIONS[name])
    .argument('[experiment]', 'experiment name in strands-dev/tmp/experiments, or the path of an Experiment JSON file')
    .option('--workspace <path>', 'open this dev workspace instead of the one in the current folder')
    .allowExcessArguments(false)
    .exitOverride()
  program.parse(own, { from: 'user' })
  const { workspace } = program.opts<{ workspace?: string }>()
  const [experiment] = program.args
  return { name, ...(experiment ? { experiment } : {}), ...(workspace ? { workspace } : {}), forkArguments }
}
