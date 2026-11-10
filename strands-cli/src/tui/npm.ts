import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CommandInvocation {
  command: string
  args: string[]
}

export interface NpmInvocationOptions {
  platform?: NodeJS.Platform
  commandShell?: string
}

/** Build an npm invocation without passing argument arrays through Node's deprecated shell option. */
export function npmInvocation(args: string[], options: NpmInvocationOptions = {}): CommandInvocation {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { command: 'npm', args }
  }
  return {
    command: options.commandShell ?? process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', windowsNpmCommand(args)],
  }
}

export async function captureCommand(command: string, args: string[], timeout?: number): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  return stdout
}

export async function captureNpm(
  args: string[],
  options: NpmInvocationOptions & { timeout?: number } = {}
): Promise<string> {
  const invocation = npmInvocation(args, options)
  return captureCommand(invocation.command, invocation.args, options.timeout)
}

function windowsNpmCommand(args: string[]): string {
  if (args.some((arg) => !/^[A-Za-z0-9@/._:+-]+$/u.test(arg))) {
    throw new Error('npm argument contains characters that are unsafe for cmd.exe')
  }
  return ['npm.cmd', ...args].join(' ')
}
