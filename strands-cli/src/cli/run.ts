import { stdin, stdout } from 'node:process'
import { CommanderError } from 'commander'
import { createHarness, harnessAgentOptionsFromConfig } from '@strands-agents/harness'

import { parseArgs, shouldPersistModelChanges, type CliRunMode, type ParsedArgs } from './arguments.js'
import { invocationAgentForRun, pythonInvocationOptions, withDiscoveredSkills } from './invocation.js'
import { initLogging } from '../logging.js'
import { runPlainChat, runTurn } from '../console.js'
import { importAgentProject } from '../tui/project/import.js'
import { rethrowWithProviderHint } from '../tui/provider/packages.js'
import { withSession } from '../tui/session/options.js'
import { buildTelemetryPing, sendTelemetryPing, telemetryEnabled } from '../tui/telemetry.js'
import { errorMessage } from '../tui/terminal/sanitize.js'
import { confirmWorkspaceMcp, resolveMcpConfig } from '../tui/workspace/trust.js'

export { TurnRenderer, runPlainChat, runTurn } from '../console.js'

/** Run the Strands CLI using ACP, Ink, plain readline, or one-shot output as the streams allow. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    // commander has already printed help / version / the parse error; honor its exit code.
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode
      return
    }
    throw err
  }

  const stdinIsTty = stdin.isTTY === true
  const mode = selectRunMode(args, { stdinIsTty, stdoutIsTty: stdout.isTTY === true })
  initLogging(mode)
  if (args.setup && mode !== 'ink') {
    process.stderr.write('error: --setup requires an interactive terminal.\n')
    process.exitCode = 1
    return
  }
  if (mode === 'acp') {
    if (args.request !== undefined || args.oneShot) {
      const conflict = args.request !== undefined ? 'a request' : '--print'
      process.stderr.write(`error: --acp-server cannot be combined with ${conflict}.\n`)
      process.exitCode = 1
      return
    }
    await runAcp(args)
    return
  }

  let request = args.request
  if (mode === 'print' && request === undefined && !stdinIsTty) {
    request = (await readStdin()).trim() || undefined
  }
  if (!request && mode === 'print') {
    process.stderr.write('No request provided. Pass one as an argument or pipe it via stdin.\n')
    process.exitCode = 1
    return
  }
  if (mode === 'print' || mode === 'plain') {
    await runConsole(args, request, mode)
  } else {
    await runInteractive(args, request)
  }
}

export function selectRunMode(
  args: Pick<ParsedArgs, 'acpServer' | 'oneShot'>,
  terminal: { stdinIsTty: boolean; stdoutIsTty: boolean }
): CliRunMode {
  if (args.acpServer) {
    return 'acp'
  }
  if (args.oneShot || !terminal.stdinIsTty) {
    return 'print'
  }
  return terminal.stdoutIsTty ? 'ink' : 'plain'
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runAcp(args: ParsedArgs): Promise<void> {
  try {
    const { runAcpServer } = await import('../tui/acp/server.js')
    const { CliConfigStore } = await import('../tui/config.js')
    const config = await CliConfigStore.load()
    config.useEnvironmentFiles(args.envFiles)
    const { settings } = config.snapshot()
    const mcp = await resolveMcpConfig(args.mcpConfig, { discovery: settings.mcpDiscovery })
    const projectPath = args.agent ?? config.snapshot().agentProject
    const project = projectPath ? importAgentProject(projectPath) : undefined
    if (project?.language === 'python') {
      const { runPythonAcpServer } = await import('../tui/project/acp.js')
      await runPythonAcpServer(project, config, await pythonInvocationOptions(args, process.cwd(), settings, mcp))
      return
    }
    const invocation = await invocationAgentForRun(args, config)
    await runAcpServer(await withDiscoveredSkills(invocation.options, settings.skillDiscovery), {
      ...(invocation.buildAgent ? { buildAgent: invocation.buildAgent } : {}),
      ...(invocation.project ? { sourceAgent: true } : {}),
      mcpPaths: mcp.paths,
      mcpStrictPaths: mcp.strictPaths,
      ...(mcp.expectedDigests ? { mcpDigests: mcp.expectedDigests } : {}),
    })
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`)
    process.exitCode = 1
  }
}

async function runConsole(args: ParsedArgs, request: string | undefined, mode: 'print' | 'plain'): Promise<void> {
  let loadedMcp: Awaited<ReturnType<(typeof import('../tui/mcp.js'))['loadMcp']>> | undefined
  let agent: Awaited<ReturnType<typeof createHarness>> | undefined
  try {
    const [{ loadMcp }, { CliConfigStore }] = await Promise.all([import('../tui/mcp.js'), import('../tui/config.js')])
    const config = await CliConfigStore.load()
    config.useEnvironmentFiles(args.envFiles)
    const projectPath = args.agent ?? config.snapshot().agentProject
    const project = projectPath ? importAgentProject(projectPath) : undefined
    if (project?.language === 'python') {
      const { runPythonConsole } = await import('../tui/project/run.js')
      const settings = config.snapshot().settings
      const mcp = await resolveMcpConfig(args.mcpConfig, {
        ...(mode === 'plain' ? { confirm: confirmWorkspaceMcp } : {}),
        discovery: settings.mcpDiscovery,
      })
      await runPythonConsole(
        project.entrypoint,
        config,
        await pythonInvocationOptions(args, process.cwd(), settings, mcp),
        request,
        mode === 'plain'
      )
      return
    }
    const invocation = await invocationAgentForRun(args, config, process.cwd(), project, true)
    const { settings } = config.snapshot()
    const options = await withDiscoveredSkills(invocation.options, settings.skillDiscovery)
    const mcp = await resolveMcpConfig(args.mcpConfig, {
      ...(mode === 'plain' ? { confirm: confirmWorkspaceMcp } : {}),
      discovery: settings.mcpDiscovery,
    })
    if (mcp.paths.length > 0) {
      loadedMcp = await loadMcp({
        paths: mcp.paths,
        strictPaths: mcp.strictPaths,
        ...(mcp.expectedDigests ? { expectedDigests: mcp.expectedDigests } : {}),
      })
      options.tools = [...(options.tools ?? []), ...loadedMcp.clients]
    }
    agent = await (invocation.buildAgent ?? createHarness)(options).catch(rethrowWithProviderHint)
    if (mode === 'print') {
      await runTurn(agent, request!)
    } else {
      await runPlainChat(agent, request)
    }
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`)
    process.exitCode = 1
  } finally {
    // Extraction runs in the background on a turn interval, so a short run exits with recent turns
    // unsaved. Flush at the process boundary to persist them, best-effort: a flush failure must not
    // fail a completed turn or skip MCP teardown.
    await Promise.allSettled([agent?.memoryManager?.flush()])
    await loadedMcp?.dispose()
  }
}

async function runInteractive(args: ParsedArgs, request: string | undefined): Promise<void> {
  try {
    await import('#ink-text-cache')
    // React's development timing buffer retains rendered props in Node. Load the production UI
    // without changing the environment inherited by tools and user commands.
    const nodeEnvironment = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      await Promise.all([import('ink'), import('react/jsx-runtime')])
    } finally {
      if (nodeEnvironment === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = nodeEnvironment
      }
    }
    const [{ runInkChat }, { CliConfigStore }] = await Promise.all([
      import('../tui/run.js'),
      import('../tui/config.js'),
    ])
    const config = await CliConfigStore.load()
    config.useEnvironmentFiles(args.envFiles)
    const initialWorkspace = process.cwd()
    let pinged = false
    process.exitCode = await runInkChat(
      async (signal, requestSetup, conversation, launch) => {
        signal.throwIfAborted()
        if (launch?.assistant) {
          const { createSetupAssistant } = await import('../tui/agent-setup.js')
          return createSetupAssistant(launch.assistant, config, requestSetup, initialWorkspace)
        }
        const initialMcp = await resolveMcpConfig(args.mcpConfig, {
          cwd: initialWorkspace,
          confirm: confirmWorkspaceMcp,
          discovery: config.snapshot().settings.mcpDiscovery,
        })
        signal.throwIfAborted()
        const projectPath =
          launch?.agentProject ?? (launch?.configuration ? undefined : (args.agent ?? config.snapshot().agentProject))
        const project = projectPath ? importAgentProject(projectPath) : undefined
        if (project?.language === 'python') {
          const { createPythonChat } = await import('../tui/project/run.js')
          return createPythonChat(
            project.entrypoint,
            config,
            await pythonInvocationOptions(args, initialWorkspace, config.snapshot().settings, initialMcp),
            signal,
            requestSetup,
            conversation
          )
        }
        const { createInteractiveChat } = await import('../tui/runtime.js')
        signal.throwIfAborted()
        if (launch?.configuration) config.applyProviderEnvironment()
        const invocation =
          launch?.configuration && !launch.agentProject
            ? {
                profile: launch.configuration.profile,
                options: await harnessAgentOptionsFromConfig(
                  launch.configuration.profile,
                  launch.configuration.profileBaseDir ?? initialWorkspace
                ),
              }
            : await invocationAgentForRun(launch?.agentProject ? { ...args, agent: launch.agentProject } : args, config)
        if (launch?.newConversation) invocation.options = withSession(invocation.options, { id: undefined })
        signal.throwIfAborted()
        const chat = await createInteractiveChat({
          agentOptions: invocation.options,
          ...(invocation.profile ? { agentProfile: invocation.profile } : {}),
          ...(invocation.buildAgent ? { buildAgent: invocation.buildAgent } : {}),
          ...(invocation.project ? { project: invocation.project } : {}),
          cwd: initialWorkspace,
          // Flags describe one run; only a profile-driven session writes model changes back to it.
          persistModelChanges:
            !invocation.project && (launch?.configuration !== undefined || shouldPersistModelChanges(args)),
          config,
          mcpPaths: initialMcp.paths,
          mcpStrictPaths: initialMcp.strictPaths,
          ...(initialMcp.expectedDigests ? { mcpDigests: initialMcp.expectedDigests } : {}),
          requestSetup,
          ...(conversation ? { conversation } : {}),
        })
        // One anonymous ping per TUI launch, built-in profile only: authored agents and non-TUI modes send nothing.
        if (invocation.profile && !pinged && !signal.aborted && telemetryEnabled(config.snapshot().settings)) {
          pinged = true
          void sendTelemetryPing(buildTelemetryPing(invocation.profile))
        }
        return chat
      },
      {
        ...(request ? { firstRequest: request } : {}),
        intro: config.snapshot().settings.animations,
        setup: args.setup || (!args.agent && (config.needsSetup() || config.snapshot().settings.setupOnLaunch)),
        config,
      }
    )
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`)
    process.exitCode = 1
  }
}
