import { posix, win32 } from 'node:path'

import { workspaceSessionDirectory } from './catalog.js'

export interface ResumeSession {
  sessionId: string
  sessionDirectory: string
  workspace: string
  agentProject?: string
}

export function sessionResumeCommand(
  session: ResumeSession,
  options: { cwd?: string; platform?: NodeJS.Platform } = {}
): string {
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const workspace = paths.resolve(session.workspace)
  const directory = paths.resolve(workspace, session.sessionDirectory)
  const quote = (value: string): string => quoteArgument(value, platform)
  const command = ['strands']
  if (session.agentProject) command.push('--agent', quote(session.agentProject))
  command.push('--session-id', quote(session.sessionId))
  if (session.agentProject || directory !== workspaceSessionDirectory(workspace)) {
    command.push('--set', quote(`session.dir=${JSON.stringify(directory)}`))
  }
  const resume = command.join(' ')
  if (workspace === paths.resolve(options.cwd ?? process.cwd())) return resume
  const changeDirectory =
    platform === 'win32'
      ? `Set-Location -LiteralPath ${quote(workspace)} -ErrorAction Stop;`
      : `cd ${quote(workspace)} &&`
  return `${changeDirectory} ${resume}`
}

function quoteArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}
