import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { stdin } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { userDirectory } from '../config.js'

import { defaultMcpPaths, projectMcpPaths } from '../mcp/config.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'

export interface ResolvedMcpConfig {
  paths: readonly string[]
  strictPaths: readonly string[]
  expectedDigests?: Readonly<Record<string, string>>
}

interface WorkspaceMcpInspection {
  readonly workspace: string
  readonly paths: readonly string[]
  readonly digests: Readonly<Record<string, string>>
  readonly fingerprint: string
}

interface TrustFile {
  version: 1
  workspaces: Record<string, string>
}

/** `discovery` is the user's setting; `STRANDS_CLI_MCP_DISCOVERY=off` overrides it for one run. */
export async function resolveMcpConfig(
  configuredPaths: readonly string[],
  {
    cwd = process.cwd(),
    confirm,
    trustPath,
    discovery = true,
  }: {
    cwd?: string
    confirm?: (workspace: string, paths: readonly string[]) => Promise<boolean>
    trustPath?: string
    discovery?: boolean
  } = {}
): Promise<ResolvedMcpConfig> {
  const explicitPaths = await canonicalPaths(configuredPaths, cwd)
  if (!discovery || process.env.STRANDS_CLI_MCP_DISCOVERY === 'off') {
    return { paths: explicitPaths, strictPaths: explicitPaths }
  }
  const explicit = new Set(explicitPaths)
  const defaultPaths = (await canonicalPaths(defaultMcpPaths(), cwd)).filter((path) => !explicit.has(path))
  const basePaths = [...defaultPaths, ...explicitPaths]
  const inspection = await inspectWorkspaceMcp(cwd)
  if (!inspection) {
    return { paths: basePaths, strictPaths: explicitPaths }
  }

  const implicitProjectPaths = inspection.paths.filter((path) => !explicit.has(path))
  if (implicitProjectPaths.length === 0) {
    return { paths: basePaths, strictPaths: explicitPaths }
  }

  let trusted = await isWorkspaceMcpTrusted(inspection, trustPath)
  if (!trusted && confirm && (await confirm(inspection.workspace, implicitProjectPaths))) {
    await trustWorkspaceMcp(inspection, trustPath)
    trusted = true
  }
  if (!trusted) {
    return { paths: basePaths, strictPaths: explicitPaths }
  }
  return {
    paths: [...new Set([...defaultPaths, ...implicitProjectPaths, ...explicitPaths])],
    strictPaths: explicitPaths,
    expectedDigests: Object.fromEntries(implicitProjectPaths.map((path) => [path, inspection.digests[path]!] as const)),
  }
}

export async function confirmWorkspaceMcp(workspace: string, paths: readonly string[]): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: process.stderr })
  try {
    process.stderr.write(
      sanitizeTerminalText(
        `Found project MCP configuration in ${workspace}:\n${paths.map((path) => `  ${path}`).join('\n')}\n`
      )
    )
    const answer = await rl.question('Trust this exact configuration and allow its MCP commands to run? [y/N] ')
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}

async function canonicalPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  return [
    ...new Set(
      await Promise.all(
        paths.map(async (path) => {
          const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
          const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
          try {
            return await realpath(absolute)
          } catch (error) {
            if (isMissing(error)) {
              return absolute
            }
            throw error
          }
        })
      )
    ),
  ]
}

export async function inspectWorkspaceMcp(cwd = process.cwd()): Promise<WorkspaceMcpInspection | undefined> {
  const workspace = await realpath(cwd)
  const digests: Record<string, string> = {}

  for (const path of projectMcpPaths(workspace)) {
    try {
      digests[path] = digest(await readFile(path))
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
    }
  }

  const existingPaths = Object.keys(digests)
  if (existingPaths.length === 0) {
    return undefined
  }
  const fingerprint = digest(
    JSON.stringify({
      workspace,
      files: [...existingPaths].sort().map((path) => ({ path, digest: digests[path] })),
    })
  )
  return { workspace, paths: existingPaths, digests, fingerprint }
}

export async function isWorkspaceMcpTrusted(
  inspection: WorkspaceMcpInspection,
  trustPath = defaultTrustPath()
): Promise<boolean> {
  const trust = await readTrustFile(trustPath)
  return trust.workspaces[inspection.workspace] === inspection.fingerprint
}

export async function trustWorkspaceMcp(
  inspection: WorkspaceMcpInspection,
  trustPath = defaultTrustPath()
): Promise<void> {
  const trust = await readTrustFile(trustPath)
  trust.workspaces[inspection.workspace] = inspection.fingerprint
  await writeTrustFile(trustPath, trust)
}

function defaultTrustPath(): string {
  return userDirectory('trusted-workspaces.json')
}

async function readTrustFile(path: string): Promise<TrustFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return { version: 1, workspaces: {} }
    }
    throw error
  }
  try {
    const value = JSON.parse(text) as Partial<TrustFile>
    if (
      value.version !== 1 ||
      !value.workspaces ||
      typeof value.workspaces !== 'object' ||
      Array.isArray(value.workspaces) ||
      Object.values(value.workspaces).some((fingerprint) => typeof fingerprint !== 'string')
    ) {
      throw new Error('expected version 1 with a workspaces object')
    }
    return { version: 1, workspaces: { ...value.workspaces } }
  } catch (error) {
    throw new Error(`Invalid workspace trust file at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

async function writeTrustFile(path: string, trust: TrustFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(trust, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
