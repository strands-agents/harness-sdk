import { spawn } from 'node:child_process'

import { readCliVersion } from '../tui/package-version.js'
import { CLI_PACKAGE, compareVersions, publishedVersion } from '../tui/update-check.js'
import { captureCommand, npmInvocation } from '../tui/npm.js'

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
      'error: `strands update` is unavailable from a development checkout. Pull the latest source and run `npm run setup` instead.\n'
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
  async capture(command, args) {
    return captureCommand(command, args)
  },
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
