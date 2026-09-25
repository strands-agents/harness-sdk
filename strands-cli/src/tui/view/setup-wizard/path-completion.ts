import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

const IMPORT_FILE_PATTERN = /\.(?:zip|ts|mts|js|mjs|py)$/iu

export interface ImportPathCompletion {
  value: string
  label: string
  directory: boolean
}

export function importPathCompletions(
  input: string,
  workingDirectory = process.cwd(),
  homeDirectory = homedir()
): ImportPathCompletion[] {
  if (!input) {
    return []
  }
  if (input === '~') {
    return [{ value: `~${sep}`, label: `~${sep}`, directory: true }]
  }

  const separatorIndex = input.lastIndexOf(sep)
  const prefix = separatorIndex < 0 ? '' : input.slice(0, separatorIndex + 1)
  const fragment = separatorIndex < 0 ? input : input.slice(separatorIndex + 1)
  const expandedPrefix =
    prefix === `~${sep}`
      ? `${homeDirectory}${sep}`
      : prefix.startsWith(`~${sep}`)
        ? join(homeDirectory, prefix.slice(2))
        : prefix
  const directory = isAbsolute(expandedPrefix) ? expandedPrefix : resolve(workingDirectory, expandedPrefix || '.')

  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) {
          return false
        }
        if (!fragment.startsWith('.') && entry.name.startsWith('.')) {
          return false
        }
        return entry.isDirectory() || (entry.isFile() && IMPORT_FILE_PATTERN.test(entry.name))
      })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })
      .map((entry) => {
        const suffix = entry.isDirectory() ? sep : ''
        return {
          value: `${prefix}${entry.name}${suffix}`,
          label: `${entry.name}${suffix}`,
          directory: entry.isDirectory(),
        }
      })
      .filter((completion) => completion.value !== input)
      .slice(0, 6)
  } catch {
    return []
  }
}
