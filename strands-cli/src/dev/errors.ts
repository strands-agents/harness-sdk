import { sanitizeTerminalText } from '../terminal/text.js'

export type DevOperation = 'open' | 'load' | 'install' | 'build' | 'reload'

export interface DevFailureContext {
  operation: DevOperation
  path?: string | undefined
}

export class DevFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'DevFailure'
  }
}

export class WorkspaceFolderInUse extends DevFailure {
  constructor(
    readonly folder: string,
    readonly holder: string
  ) {
    super(
      [
        'Workspace folder is in use.',
        `Folder: ${sanitizeTerminalText(folder)}`,
        `Reason: It holds the workspace of ${sanitizeTerminalText(holder)}.`,
        'Next: Run strands dev in a terminal and pick this agent again to replace that workspace, ' +
          'or choose another folder with --workspace <path>.',
      ].join('\n'),
      undefined
    )
    this.name = 'WorkspaceFolderInUse'
  }
}

const causes = (error: unknown): unknown[] => {
  const result: unknown[] = []
  for (let current = error; current && !result.includes(current) && result.length < 8;) {
    result.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return result
}

const field = (error: unknown, name: string): string | undefined => {
  if (!error || typeof error !== 'object' || !(name in error)) return undefined
  const value: unknown = Reflect.get(error, name)
  return typeof value === 'string' ? value : undefined
}

const reason = (errors: unknown[]): string => {
  const lines = errors.flatMap((error) =>
    sanitizeTerminalText(error instanceof Error ? error.message : String(error)).split('\n')
  )
  const diagnostic = lines.find((line) =>
    /^(?:SyntaxError|ModuleNotFoundError|ImportError|Error \[ERR_MODULE_NOT_FOUND\]|error TS\d+|npm (?:error|ERR!))/u.test(
      line.trim()
    )
  )
  const selected =
    diagnostic ?? lines.find((line) => line.trim() && !/^\s*(?:at |File ")/u.test(line)) ?? 'Unknown error.'
  return selected.trim().slice(0, 300)
}

export const devFailure = (error: unknown, context: DevFailureContext): DevFailure => {
  if (error instanceof DevFailure && context.operation !== 'reload') return error
  const chain = causes(error)
  const code = chain.map((item) => field(item, 'code')).find(Boolean)
  const path = chain.map((item) => field(item, 'path')).find(Boolean) ?? context.path
  const detail = reason(chain)
  const install =
    context.operation === 'install' ||
    chain.some((item) => item instanceof Error && item.message.includes("Could not install the agent's dependencies"))
  const missing = code === 'ENOENT' || code === 'ENOTDIR'
  const missingModule = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
  const build = context.operation === 'build' || /error TS\d+|Compilation failed|Build failed/iu.test(detail)
  const title =
    context.operation === 'reload'
      ? 'Agent reload failed.'
      : install
        ? 'Agent dependency setup failed.'
        : missing
          ? 'Agent file not found.'
          : missingModule
            ? 'Agent dependency missing.'
            : build
              ? 'Agent build failed.'
              : context.operation === 'load'
                ? 'Agent could not start.'
                : 'Workspace could not open.'
  const action =
    context.operation === 'reload'
      ? 'Fix the source or dependencies, then save again to retry.'
      : install
        ? 'Check the dependency files and registry access, then retry this workspace.'
        : missingModule
          ? 'Install the project dependencies, then retry this workspace.'
          : build
            ? 'Fix the build error and rebuild the agent, then retry this workspace.'
            : missing
              ? 'Restore the missing path or select the correct agent with strands dev --agent <path>.'
              : 'Fix the reported source or configuration, then retry this workspace.'
  const lines = [
    title,
    ...(path ? [`Path: ${sanitizeTerminalText(path)}`] : []),
    `Reason: ${detail}`,
    ...(context.operation === 'reload' ? ['The previous working agent and session are still active.'] : []),
    `Next: ${action}`,
  ]
  return new DevFailure(lines.join('\n'), error)
}
