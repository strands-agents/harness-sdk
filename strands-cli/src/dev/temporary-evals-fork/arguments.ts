import { Command } from 'commander'

export interface TemporaryDevOptimizeArguments {
  experiment?: string
  workspace?: string
  forkArguments: string[]
}

export const parseTemporaryDevOptimizeArguments = (argv: string[]): TemporaryDevOptimizeArguments => {
  const separator = argv.indexOf('--')
  const own = separator < 0 ? argv : argv.slice(0, separator)
  const forkArguments = separator < 0 ? [] : argv.slice(separator + 1)
  const program = new Command()
    .name('strands dev optimize')
    .description(
      'TEMPORARY: tune the dev workspace agent against an experiment in strands-dev/tmp/experiments with the ' +
        'strands-evals optimize command from the evals fork. Flags after -- go to strands-evals optimize.'
    )
    .argument('[experiment]', 'experiment name in strands-dev/tmp/experiments, or the path of an Experiment JSON file')
    .option('--workspace <path>', 'open this dev workspace instead of the one in the current folder')
    .allowExcessArguments(false)
    .exitOverride()
  program.parse(own, { from: 'user' })
  const { workspace } = program.opts<{ workspace?: string }>()
  const [experiment] = program.args
  return { ...(experiment ? { experiment } : {}), ...(workspace ? { workspace } : {}), forkArguments }
}
