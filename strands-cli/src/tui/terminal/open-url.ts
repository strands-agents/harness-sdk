import { spawn } from 'node:child_process'

export interface SystemOpenCommand {
  command: string
  args: readonly string[]
}

export function systemOpenCommand(platform: NodeJS.Platform, target: string): SystemOpenCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [target] }
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', target] }
  }
  return { command: 'xdg-open', args: [target] }
}

export function openExternalUrl(url: string): void {
  const { command, args } = systemOpenCommand(process.platform, url)
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}
