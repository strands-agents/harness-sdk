import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PackagedSource =
  { source: string; destination: string; directoryOnly?: boolean } | { contents: string; destination: string }

export function realSource(path: string, fileOnly = false, baseDir = process.cwd()): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  const candidate = resolve(baseDir, expanded)
  const details = lstatSync(candidate)
  if (!details.isFile() && (!details.isDirectory() || fileOnly)) {
    throw new Error(
      `Export source ${JSON.stringify(path)} must be ${fileOnly ? 'a regular file' : 'a regular file or directory'}.`
    )
  }
  return realpathSync(candidate)
}

export function packageSources(
  roots: readonly string[],
  destination: string,
  sources: PackagedSource[],
  cwd?: string
): (path: string) => string {
  const base = sourceBase(roots, cwd)
  const target = (path: string): string =>
    [destination, relative(base, path).split(sep).join('/')].filter(Boolean).join('/')
  const unique = [...new Set(roots)].filter(
    (root, _index, paths) => !paths.some((other) => other !== root && containsPath(other, root))
  )
  for (const source of unique) {
    sources.push({ source, destination: target(source) })
  }
  if (cwd && !unique.some((root) => containsPath(root, cwd))) {
    sources.push({ source: cwd, destination: target(cwd), directoryOnly: true })
  }
  return target
}

export function packageName(value: string, used: Set<string>): string {
  const name = value.replace(/[^a-z0-9._-]/giu, '-').replace(/^[.-]+|[.-]+$/gu, '') || 'source'
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ? `_${name}` : name
  let result = safe
  for (let suffix = 2; used.has(result.toLowerCase()); suffix++) {
    const extension = /\.[^.]+$/u.exec(safe)?.[0] ?? ''
    result = `${safe.slice(0, safe.length - extension.length)}-${suffix}${extension}`
  }
  used.add(result.toLowerCase())
  return result
}

export function containsPath(root: string, path: string): boolean {
  const result = relative(root, path)
  return !result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result)
}

export function sourceBase(roots: readonly string[], cwd?: string): string {
  const first = roots[0]
  if (!first) {
    throw new Error('At least one export source is required.')
  }
  let base = cwd ?? (lstatSync(first).isDirectory() ? first : dirname(first))
  for (const root of roots) {
    while (!containsPath(base, root)) {
      base = dirname(base)
    }
  }
  return base
}
