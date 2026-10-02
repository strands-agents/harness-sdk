import { existsSync, lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HarnessAgentConfig } from '@strands-agents/harness'

import type { AgentProjectLanguage } from './import.js'
import { containsPath, packageName, packageSources, realSource, type PackagedSource } from './packaging.js'

export function packageMcpServers(
  servers: Record<string, unknown>,
  baseDir: string,
  sources: PackagedSource[],
  language: AgentProjectLanguage,
  dependencies: HarnessAgentConfig['dependencies']
): Record<string, unknown> {
  const names = new Set<string>()
  const packages = new Map<string, (path: string) => string>()
  return Object.fromEntries(
    Object.entries(servers).map(([name, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [name, raw]
      }
      const { files, ...server } = raw as Record<string, unknown>
      if (
        files !== undefined &&
        (!Array.isArray(files) || files.some((path) => typeof path !== 'string' || !path.trim()))
      ) {
        throw new Error(`MCP server ${JSON.stringify(name)} files must contain source paths.`)
      }
      if (typeof server.command !== 'string') {
        return [name, server]
      }
      const declared = (files as string[] | undefined)?.map((path) => realSource(path, false, baseDir)) ?? []
      if (typeof server.cwd === 'string' && server.cwd.includes('${')) {
        if (declared.length > 0) {
          throw new Error(`MCP server ${JSON.stringify(name)} needs a concrete cwd to package its files.`)
        }
        return [name, server]
      }
      const cwd = realSource(typeof server.cwd === 'string' ? server.cwd : '.', false, baseDir)
      if (!lstatSync(cwd).isDirectory()) {
        throw new Error(`MCP server ${JSON.stringify(name)} cwd must be a directory.`)
      }
      const roots = [...declared]
      const localPath = (value: unknown, infer = true): string | undefined => {
        if (typeof value !== 'string' || value.includes('${') || value.startsWith('-')) {
          return undefined
        }
        const candidate = resolve(cwd, value)
        if (!existsSync(candidate)) {
          return undefined
        }
        const path = realSource(value, false, cwd)
        const declaredPath = declared.some((root) => containsPath(root, path))
        if (!infer && !declaredPath) {
          return undefined
        }
        const explicit = value.startsWith('.') || isAbsolute(value)
        const script = /\.(?:[cm]?[jt]s|py|sh)$/iu.test(value)
        if (!explicit && !script && !declaredPath) {
          return undefined
        }
        if (!declared.some((root) => containsPath(root, path))) {
          if (!script || !lstatSync(path).isFile()) {
            throw new Error(
              `MCP server ${JSON.stringify(name)} must declare ${JSON.stringify(value)} in files or use an environment placeholder.`
            )
          }
          roots.push(path)
        }
        return path
      }
      const command = localPath(server.command)
      const inferArguments = /^(?:node|python(?:\d+(?:\.\d+)*)?|(?:ba|da|z)?sh)(?:\.exe)?$/iu.test(
        basename(server.command)
      )
      const args = Array.isArray(server.args) ? server.args.map((value) => localPath(value, inferArguments)) : []
      const needsOtherDependencies =
        language === 'typescript' &&
        dependencies.python.length > 0 &&
        (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/iu.test(basename(server.command)) ||
          [command, ...args].some((path) => path && /\.py$/iu.test(path)))
      if (needsOtherDependencies) {
        throw new Error(
          `The TypeScript export does not install dependencies.python required by MCP server ${JSON.stringify(name)}. Use a self-contained package runner (uvx), export in python, or remove unused dependency declarations.`
        )
      }
      if (roots.length === 0) {
        if (cwd !== realSource('.', false, baseDir)) {
          throw new Error(`MCP server ${JSON.stringify(name)} must declare files for its local cwd.`)
        }
        return [name, { ...server, ...(server.cwd === undefined ? {} : { cwd: '.' }) }]
      }
      const packageRoots = roots.filter(
        (root) => inferredLanguage(root) === 'typescript' || lstatSync(root).isDirectory()
      )
      for (const root of packageRoots) {
        let directory = lstatSync(root).isDirectory() ? root : dirname(root)
        for (;;) {
          const manifest = join(directory, 'package.json')
          if (existsSync(manifest)) {
            roots.push(realSource(manifest, true, directory))
            break
          }
          const parent = dirname(directory)
          if (parent === directory || basename(directory) === 'node_modules') break
          directory = parent
        }
      }
      const key = JSON.stringify([cwd, [...new Set(roots)].sort()])
      let target = packages.get(key)
      if (!target) {
        const destination = `mcp/${packageName(name, names)}`
        target = packageSources(roots, destination, sources, cwd)
        packages.set(key, target)
        if (packageRoots.length > 0 && !roots.some((root) => target!(root) === `${destination}/package.json`)) {
          sources.push({ destination: `${destination}/package.json`, contents: '{}\n' })
        }
      }
      const fromCwd = (path: string): string => `./${relative(target(cwd), target(path)).split(sep).join('/')}`
      return [
        name,
        {
          ...server,
          cwd: `./agent/${target(cwd)}`,
          ...(command ? { command: fromCwd(command) } : {}),
          ...(Array.isArray(server.args)
            ? { args: server.args.map((value, index) => (args[index] ? fromCwd(args[index]) : value)) }
            : {}),
        },
      ]
    })
  )
}

function inferredLanguage(module: string): AgentProjectLanguage | undefined {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(module)) {
    return 'typescript'
  }
  return /\.py$/iu.test(module) ? 'python' : undefined
}
