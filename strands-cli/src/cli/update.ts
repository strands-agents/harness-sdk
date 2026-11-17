import { spawn } from 'node:child_process'
import { compare, valid } from 'semver'
import { readCliVersion } from '../package-version.js'
import { captureCommand, captureNpm, npmInvocation } from '../terminal/npm.js'

export const CLI_PACKAGE = '@strands-agents/cli'

export interface UpdateCheckOptions {
  currentVersion?: string
  resolveLatest?: () => Promise<string>
}

/** Resolves the latest published CLI version when it is newer than this one, or undefined when unknown. */
export async function availableCliUpdate(options: UpdateCheckOptions = {}): Promise<string | undefined> {
  const currentVersion = options.currentVersion ?? readCliVersion()
  if (currentVersion.includes('development')) {
    return undefined
  }
  try {
    const latestVersion = await (options.resolveLatest ?? resolveLatestCliVersion)()
    return compareVersions(latestVersion, currentVersion) === 1 ? latestVersion : undefined
  } catch {
    // Setup stays usable offline; the notice only appears when npm resolves the configured registry.
    return undefined
  }
}

async function resolveLatestCliVersion(): Promise<string> {
  return publishedVersion(await captureNpm(['view', `${CLI_PACKAGE}@latest`, 'version', '--json'], { timeout: 3_000 }))
}

export function publishedVersion(output: string): string {
  const parsed = JSON.parse(output) as unknown
  if (typeof parsed !== 'string' || !parsed.trim()) {
    throw new Error('npm returned an invalid package version')
  }
  return parsed.trim()
}

/** Orders two versions by semver precedence, or undefined when either is not a valid version. */
export function compareVersions(candidate: string, current: string): -1 | 0 | 1 | undefined {
  return valid(candidate) && valid(current) ? compare(candidate, current) : undefined
}

export interface UpdateRunner {
  capture(command: string, args: string[]): Promise<string>
  inherit(command: string, args: string[]): Promise<number>
}

export interface UpdateOptions {
  currentVersion?: string
  runner?: UpdateRunner
  output?: Pick<NodeJS.WriteStream, 'write'>
  errorOutput?: Pick<NodeJS.WriteStream, 'write'>
  platform?: NodeJS.Platform
  commandShell?: string
}

/** Update the globally installed CLI through npm. */
export async function updateCli(options: UpdateOptions = {}): Promise<number> {
  const currentVersion = options.currentVersion ?? readCliVersion()
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const runner = options.runner ?? nodeUpdateRunner
  const invocationOptions = {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.commandShell !== undefined ? { commandShell: options.commandShell } : {}),
  }

  if (currentVersion.includes('development')) {
    errorOutput.write(
      'error: This is a development checkout, so npm cannot update it. Update it with Git; `npm run setup` only rebuilds the local CLI afterward.\n'
    )
    return 1
  }

  try {
    const lookup = npmInvocation(['view', `${CLI_PACKAGE}@latest`, 'version', '--json'], invocationOptions)
    const latestVersion = publishedVersion(await runner.capture(lookup.command, lookup.args))
    const versionOrder = compareVersions(latestVersion, currentVersion)
    if (versionOrder === undefined) {
      throw new Error(`npm returned an invalid package version ${JSON.stringify(latestVersion)}`)
    }
    if (versionOrder !== 1) {
      output.write(
        versionOrder === 0
          ? `Strands CLI ${currentVersion} is already up to date.\n`
          : `Strands CLI ${currentVersion} is newer than npm latest ${latestVersion}; no update was installed.\n`
      )
      return 0
    }

    output.write(`Updating Strands CLI from ${currentVersion} to ${latestVersion}...\n`)
    const install = npmInvocation(['install', '--global', `${CLI_PACKAGE}@${latestVersion}`], invocationOptions)
    const exitCode = await runner.inherit(install.command, install.args)
    if (exitCode !== 0) {
      errorOutput.write(
        `error: Update failed with exit code ${exitCode}. Retry with \`npm install --global ${CLI_PACKAGE}@latest\`.\n`
      )
      return exitCode
    }
    output.write(`Updated Strands CLI to ${latestVersion}. Run \`strands\` again to use it.\n`)
    return 0
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    errorOutput.write(`error: Unable to update the Strands CLI: ${detail}\n`)
    return 1
  }
}

const nodeUpdateRunner: UpdateRunner = {
  capture: captureCommand,
  async inherit(command, args) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (signal) {
          reject(new Error(`npm was terminated by ${signal}`))
        } else {
          resolve(code ?? 1)
        }
      })
    })
  },
}
