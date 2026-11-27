import { Command } from 'commander'

export type EvalsDevCommandName = 'optimize' | 'evaluate'

interface EvalsDevCommandArguments {
  name: EvalsDevCommandName
  experiment?: string
  workspace?: string
  evalsArguments: string[]
}

const DESCRIPTIONS: Record<EvalsDevCommandName, string> = {
  optimize:
    'Experimental: tune the dev workspace agent against an experiment in strands-dev/experiments with ' +
    'strands-evals optimize run. Flags after -- go to strands-evals optimize run. ' +
    '--max-iterations 0 measures only the baseline.',
  evaluate:
    'Experimental: run the dev workspace agent on an experiment in strands-dev/experiments with strands-evals run ' +
    "and save the report in the experiment's runs folder. Flags after -- go to strands-evals run.",
}

export const isEvalsDevCommand = (name: string | undefined): name is EvalsDevCommandName =>
  name === 'optimize' || name === 'evaluate'

export const parseEvalsDevCommandArguments = (name: EvalsDevCommandName, argv: string[]): EvalsDevCommandArguments => {
  const separator = argv.indexOf('--')
  const own = separator < 0 ? argv : argv.slice(0, separator)
  const evalsArguments = separator < 0 ? [] : argv.slice(separator + 1)
  const program = new Command()
    .name(`strands dev ${name}`)
    .description(DESCRIPTIONS[name])
    .argument(
      '[experiment]',
      'experiment name in strands-dev/experiments/<name>/, or the path of an Experiment JSON file'
    )
    .option('--workspace <path>', 'open this dev workspace instead of the one in the current folder')
    .allowExcessArguments(false)
    .exitOverride()
  program.parse(own, { from: 'user' })
  const { workspace } = program.opts<{ workspace?: string }>()
  const [experiment] = program.args
  return { name, ...(experiment ? { experiment } : {}), ...(workspace ? { workspace } : {}), evalsArguments }
}
