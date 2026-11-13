import { spawn } from 'node:child_process'

export interface SystemOpenCommand {
  command: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}

export function systemOpenCommand(platform: NodeJS.Platform, target: string): SystemOpenCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [target] }
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:STRANDS_CLI_OPEN_TARGET'],
      env: { STRANDS_CLI_OPEN_TARGET: target },
    }
  }
  return { command: 'xdg-open', args: [target] }
}

export function openExternalUrl(url: string): void {
  const { command, args, env } = systemOpenCommand(process.platform, url)
  const child = spawn(command, args, {
    env: env ? { ...process.env, ...env } : process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}
