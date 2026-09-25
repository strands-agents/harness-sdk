import { spawn } from 'node:child_process'

export function externalUrlCommand(
  platform: NodeJS.Platform,
  url: string
): { command: string; args: readonly string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

export function openExternalUrl(url: string): void {
  const { command, args } = externalUrlCommand(process.platform, url)
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}
