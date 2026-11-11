import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import { isTemporaryExperimentName } from './experiment.js'

export type TemporaryExperimentUse = 'optimize' | 'test'

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const experimentNames = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
}

const listed = (names: readonly string[]): string => names.map((name) => basename(name, '.json')).join(', ')

const missingExperiment = (
  folder: string,
  requested: string,
  names: readonly string[],
  use: TemporaryExperimentUse
): Error => {
  if (!isTemporaryExperimentName(requested))
    return new Error(
      `No experiment file at ${resolve(requested)}. Check the path, or name an experiment in ${folder}` +
        (names.length > 0 ? `: ${listed(names)}.` : '.')
    )
  return new Error(
    names.length > 0
      ? `No experiment named ${requested} in ${folder}. Use one of ${listed(names)}, or create it with ` +
          `/experiment ${requested} <what the agent does> in a strands dev chat.`
      : `No experiment named ${requested} yet. Create it with /experiment ${requested} <what the agent does> ` +
          `in a strands dev chat, then run /${use} ${requested}.`
  )
}

export const resolveTemporaryExperiment = async (
  folder: string,
  requested?: string,
  use: TemporaryExperimentUse = 'optimize'
): Promise<string> => {
  const names = await experimentNames(folder)
  if (requested) {
    for (const candidate of [resolve(requested), join(folder, requested), join(folder, `${requested}.json`)]) {
      if (await isFile(candidate)) return candidate
    }
    throw missingExperiment(folder, requested, names, use)
  }
  if (names.length === 1) return join(folder, names[0]!)
  if (names.length === 0)
    throw new Error(
      `There is no experiment to ${use} yet. Create one with /experiment <name> <what the agent does> ` +
        `in a strands dev chat, then run /${use} <name>. You can also save an Experiment JSON file in ${folder}.`
    )
  const example = basename(names[0]!, '.json')
  throw new Error(
    `${folder} has more than one experiment: ${listed(names)}. Name the one to use, for example ` +
      `/${use} ${example} in a chat, or strands dev ${use} ${example} in a shell.`
  )
}

export const temporaryCaseCount = async (path: string): Promise<number> => {
  let experiment: unknown
  try {
    experiment = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `${path} is not a usable Experiment file (${errorMessage(error)}). Fix the file, or make a new one with ` +
        '/experiment <name> <what the agent does>, then try again.',
      { cause: error }
    )
  }
  return isRecord(experiment) && Array.isArray(experiment.cases) ? experiment.cases.length : 0
}
