import { createHarness, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
import { CommanderError } from 'commander'
import { stdin, stdout } from 'node:process'

import { confirmWorkspaceMcp, resolveMcpConfig } from '../config/trust.js'
import { initLogging } from '../logging.js'
import { rethrowWithProviderHint } from '../model/packages.js'
import { importAgentProject } from '../project/import.js'
import { initializeAgentDefinition } from '../session/agent-definition.js'
import { errorMessage } from '../terminal/text.js'
import { parseArgs, shouldPersistModelChanges, type CliRunMode, type ParsedArgs } from './arguments.js'
import { runPlainChat, runTurn } from './console.js'
import { invocationAgentForRun, pythonInvocationOptions, withDiscoveredSkills } from './invocation.js'
import { buildTelemetryPing, sendTelemetryPing, telemetryEnabled } from './telemetry.js'
import type { CliConfigStore } from '../config/store.js'
import type { StartupScreen, WorkspaceChange } from '../ui/run.js'
import type { WorkspaceAction } from '../agent/configuration.js'
import { devFailure } from '../dev/errors.js'

export { runPlainChat, runTurn, TurnRenderer } from './console.js'

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

  if (args.update) {
    const { updateCli } = await import('./update.js')
    process.exitCode = await updateCli()
    return
  }
  if (args.dev) {
    const previousDirectory = process.cwd()
    try {
      if (stdin.isTTY && stdout.isTTY && !args.oneShot) {
        initLogging('ink')
        await runInteractive(args, args.request)
      } else {
        const { prepareDevRun } = await import('../dev/prepare.js')
        const prepared = await prepareDevRun(args, { deferPreparation: true })
        if (prepared) {
          const { planProjectPreparation, describePreparationCommand } = await import('../project/preparation-plan.js')
          const { executePreparation, redactPreparationOutput } = await import('../project/preparation.js')
          const plan = await planProjectPreparation({
            root: prepared.workspace.root,
            entrypoint: prepared.workspace.entrypoint,
            language: prepared.workspace.config.language,
          })
          process.stderr.write(
            `Project root: ${plan.project.root}\nRuntime: ${plan.runtime}\n${plan.commands.map((step) => redactPreparationOutput(describePreparationCommand(step))).join('\n')}\n${plan.guidance ?? ''}\n`
          )
          await executePreparation(plan)
          const { ensureInitialCandidate } = await import('../dev/initialize.js')
          await ensureInitialCandidate(prepared.workspace, undefined, async (candidate) => {
            await executePreparation(await planProjectPreparation(candidate))
          })
          prepared.args.dev = { ...prepared.args.dev!, prepared: true }
        }
        if (!prepared || prepared.args.dev?.init) return
        process.chdir(prepared.workspace.root)
        await runSession(prepared.args, prepared.config)
      }
    } catch (error) {
      process.stderr.write(
        `error: ${devFailure(error, { operation: 'open', path: args.agent ?? args.dev?.workspace }).message}\n`
      )
      process.exitCode = 1
    } finally {
      process.chdir(previousDirectory)
    }
    return
  }
  await runSession(args)
}

const runSession = async (args: ParsedArgs, suppliedConfig?: CliConfigStore): Promise<void> => {
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
    await runConsole(args, request, mode, suppliedConfig)
  } else {
    await runInteractive(args, request, suppliedConfig)
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
    const { runAcpServer } = await import('./acp.js')
    const { CliConfigStore } = await import('../config/store.js')
    const config = await CliConfigStore.load()
    config.useEnvironmentFiles(args.envFiles)
    const { settings } = config.snapshot()
    const mcp = await resolveMcpConfig(args.mcpConfig, { discovery: settings.mcpDiscovery })
    const projectPath = args.agent ?? config.snapshot().agentProject
    const project = projectPath ? importAgentProject(projectPath) : undefined
    if (project?.language === 'python') {
      const { runPythonAcpServer } = await import('./acp-python.js')
      await runPythonAcpServer(project, config, await pythonInvocationOptions(args, process.cwd(), settings, mcp))
      return
    }
    const invocation = await invocationAgentForRun(args, config)
    await runAcpServer(await withDiscoveredSkills(invocation.options, settings.skillDiscovery), {
      ...(invocation.buildAgent ? { buildAgent: invocation.buildAgent } : {}),
      mcpPaths: mcp.paths,
      mcpStrictPaths: mcp.strictPaths,
      ...(mcp.expectedDigests ? { mcpDigests: mcp.expectedDigests } : {}),
    })
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`)
    process.exitCode = 1
  }
}

async function runConsole(
  args: ParsedArgs,
  request: string | undefined,
  mode: 'print' | 'plain',
  suppliedConfig?: CliConfigStore
): Promise<void> {
  let loadedMcp: Awaited<ReturnType<(typeof import('../agent/mcp.js'))['loadMcp']>> | undefined
  let agent: Awaited<ReturnType<typeof createHarness>> | undefined
  try {
    const [{ loadMcp }, { CliConfigStore }] = await Promise.all([
      import('../agent/mcp.js'),
      import('../config/store.js'),
    ])
    const config = suppliedConfig ?? (await CliConfigStore.load())
    config.useEnvironmentFiles(args.envFiles)
    const projectPath = args.agent ?? config.snapshot().agentProject
    const project = projectPath ? importAgentProject(projectPath) : undefined
    if (project?.language === 'python') {
      const { runPythonConsole } = await import('./console.js')
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
    const invocation = await invocationAgentForRun(args, config, process.cwd(), project)
    const { settings } = config.snapshot()
    const options = await withDiscoveredSkills(invocation.options, settings.skillDiscovery)
    const mcp = await resolveMcpConfig(args.mcpConfig, {
      ...(mode === 'plain' ? { confirm: confirmWorkspaceMcp } : {}),
      discovery: settings.mcpDiscovery,
    })
    if (options.mcpServers || mcp.paths.length > 0) {
      loadedMcp = await loadMcp({
        ...(options.mcpServers ? { servers: options.mcpServers } : {}),
        paths: mcp.paths,
        strictPaths: mcp.strictPaths,
        ...(mcp.expectedDigests ? { expectedDigests: mcp.expectedDigests } : {}),
      })
      // Exported source factories retain authored options unless the override contains the key.
      Reflect.set(options, 'mcpServers', undefined)
      options.tools = [...(options.tools ?? []), ...loadedMcp.clients]
    }
    agent = await (invocation.buildAgent ?? createHarness)(options).catch(rethrowWithProviderHint)
    await initializeAgentDefinition(agent)
    if (mode === 'print') {
      await runTurn(agent, request!)
    } else {
      await runPlainChat(agent, request)
    }
  } catch (err) {
    process.stderr.write(
      `error: ${args.dev ? devFailure(err, { operation: 'load', path: args.agent ?? args.dev.workspace }).message : errorMessage(err)}\n`
    )
    process.exitCode = 1
  } finally {
    // Cleanup failure must not fail a completed turn or skip MCP teardown.
    await Promise.allSettled([agent?.shutdown(), loadedMcp?.dispose()])
  }
}

async function runInteractive(
  args: ParsedArgs,
  request: string | undefined,
  suppliedConfig?: CliConfigStore
): Promise<void> {
  try {
    await import('../terminal/ink.js')
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
      import('../ui/run.js'),
      import('../config/store.js'),
    ])
    const config =
      suppliedConfig ??
      (args.dev ? await CliConfigStore.load(undefined, { persist: false }) : await CliConfigStore.load())
    config.useEnvironmentFiles(args.envFiles)
    const savedConfig = config.snapshot()
    let initialWorkspace = process.cwd()
    if (args.dev) await config.setSettings({ updatePrompts: false, telemetry: false })
    const launchDirectory = process.cwd()
    const requestedArgs = args
    const setupSession = args.dev ? (await import('../dev/project-setup.js')).projectSetupSession() : undefined
    let selectAgain = false
    const prepare =
      args.dev && !suppliedConfig
        ? async (screen: StartupScreen): Promise<boolean> => {
            const { prepareDevRun } = await import('../dev/prepare.js')
            for (;;) {
              process.chdir(launchDirectory)
              const selectionArgs = selectAgain
                ? {
                    ...requestedArgs,
                    agent: undefined,
                    dev: {
                      init: requestedArgs.dev!.init,
                      searchRoots: requestedArgs.dev!.searchRoots,
                      ...(requestedArgs.dev!.workspace ? { workspace: requestedArgs.dev!.workspace } : {}),
                    },
                  }
                : requestedArgs
              const prepared = await prepareDevRun(selectionArgs, {
                config,
                screen,
                deferPreparation: true,
                forceSelection: selectAgain,
              })
              if (!prepared || screen.signal.aborted) return false
              const result = await setupSession!.prepare(
                {
                  root: prepared.workspace.root,
                  entrypoint: prepared.workspace.entrypoint,
                  language: prepared.workspace.config.language,
                },
                screen,
                async (install): Promise<void> => {
                  screen.show(undefined, 'Preparing initial candidate copy…')
                  const { ensureInitialCandidate } = await import('../dev/initialize.js')
                  const { planProjectPreparation } = await import('../project/preparation-plan.js')
                  const { executePreparation } = await import('../project/preparation.js')
                  await ensureInitialCandidate(prepared.workspace, screen.signal, async (candidate): Promise<void> => {
                    if (install)
                      await executePreparation(await planProjectPreparation(candidate), { signal: screen.signal })
                  })
                }
              )
              if (result === 'cancel') return false
              if (result === 'back') {
                selectAgain = true
                continue
              }
              args = { ...prepared.args, dev: { ...prepared.args.dev!, prepared: true } }
              initialWorkspace = prepared.workspace.root
              process.chdir(initialWorkspace)
              return true
            }
          }
        : undefined
    let pinged = false
    let updateRequested = false
    const exitCode = await runInkChat(
      async (signal, requestSetup, conversations, launch, confirmMcp) => {
        signal.throwIfAborted()
        const initialMcp = await resolveMcpConfig(args.mcpConfig, {
          cwd: initialWorkspace,
          confirm: confirmMcp,
          discovery: config.snapshot().settings.mcpDiscovery,
        })
        signal.throwIfAborted()
        const profile = launch?.profile ?? launch?.configuration?.profile
        if (args.dev && launch?.agentProject && launch.agentProject !== args.agent) {
          throw new Error(
            'A dev session stays with its workspace harness. Restart strands dev to select another workspace.'
          )
        }
        const projectPath = args.dev
          ? args.agent
          : (launch?.agentProject ?? (profile ? undefined : (args.agent ?? config.snapshot().agentProject)))
        if (args.dev && !projectPath) throw new Error('The dev workspace has no harness entrypoint.')
        const project = projectPath ? importAgentProject(projectPath) : undefined
        if (project?.language === 'python') {
          const { createPythonChat } = await import('../ui/chat/runtime.js')
          return createPythonChat(
            project.entrypoint,
            config,
            await pythonInvocationOptions(args, initialWorkspace, config.snapshot().settings, initialMcp),
            signal,
            requestSetup,
            conversations,
            launch?.conversationId
          )
        }
        if (project?.language === 'typescript') {
          const { createTypescriptChat } = await import('../ui/chat/runtime.js')
          return createTypescriptChat(
            project.entrypoint,
            config,
            {
              args: launch?.agentProject ? { ...args, agent: project.entrypoint } : args,
              cwd: initialWorkspace,
              initialWorkspace,
              mcpPaths: initialMcp.paths,
              mcpStrictPaths: initialMcp.strictPaths,
              ...(initialMcp.expectedDigests ? { mcpDigests: initialMcp.expectedDigests } : {}),
            },
            signal,
            requestSetup,
            conversations,
            launch?.conversationId
          )
        }
        const { createInteractiveChat } = await import('../ui/chat/runtime.js')
        signal.throwIfAborted()
        if (launch?.configuration) config.applyProviderEnvironment()
        const invocation =
          profile && !launch?.agentProject
            ? {
                profile,
                options: await harnessAgentOptionsFromConfig(
                  profile,
                  config.snapshot().profileBaseDir ?? initialWorkspace
                ),
              }
            : await invocationAgentForRun(launch?.agentProject ? { ...args, agent: launch.agentProject } : args, config)
        signal.throwIfAborted()
        const chat = await createInteractiveChat(
          {
            agentOptions: invocation.options,
            ...(invocation.profile ? { agentProfile: invocation.profile } : {}),
            ...(invocation.buildAgent ? { buildAgent: invocation.buildAgent } : {}),
            ...(invocation.project ? { project: invocation.project } : {}),
            cwd: initialWorkspace,
            // A profile accompanying configuration preserves runtime flags without saving them as defaults.
            persistModelChanges:
              !invocation.project &&
              ((profile !== undefined && !(launch?.configuration && launch.profile)) ||
                shouldPersistModelChanges(args)),
            config,
            mcpPaths: initialMcp.paths,
            mcpStrictPaths: initialMcp.strictPaths,
            ...(initialMcp.expectedDigests ? { mcpDigests: initialMcp.expectedDigests } : {}),
            requestSetup,
          },
          conversations,
          launch?.conversationId
        )
        // One anonymous ping per TUI launch, built-in profile only: authored agents and non-TUI modes send nothing.
        if (invocation.profile && !pinged && !signal.aborted && telemetryEnabled(config.snapshot().settings)) {
          pinged = true
          void sendTelemetryPing(buildTelemetryPing(invocation.profile))
        }
        return chat
      },
      {
        ...(request ? { firstRequest: request } : {}),
        intro: !args.dev && config.snapshot().settings.animations,
        setup: !args.dev && (args.setup || (!args.agent && !config.snapshot().agentProject && config.needsSetup())),
        ...(prepare ? { prepare } : {}),
        ...(args.dev?.init ? { exitAfterInitialization: true } : {}),
        ...(setupSession
          ? {
              recoverStartup: async (error: unknown, screen: StartupScreen): Promise<'retry' | 'back' | 'exit'> => {
                const action = await setupSession.recover(error, screen)
                if (action === 'back') selectAgain = true
                return action
              },
            }
          : {}),
        config,
        ...(args.dev
          ? {
              onWorkspaceAction: async (
                action: WorkspaceAction,
                screen: StartupScreen
              ): Promise<WorkspaceChange | undefined> => {
                const { prepareWorkspaceChange } = await import('../dev/manage.js')
                return prepareWorkspaceChange({
                  args,
                  savedConfig,
                  launchDirectory,
                  action,
                  screen,
                  select: async (nextArgs, directory) => {
                    args = nextArgs
                    initialWorkspace = directory
                    await config.useAgentProject(nextArgs.agent!)
                    process.chdir(directory)
                  },
                })
              },
            }
          : {}),
        onUpdateRequested: () => {
          updateRequested = true
        },
      }
    )
    if (updateRequested) {
      const { updateCli } = await import('./update.js')
      process.exitCode = await updateCli()
    } else {
      process.exitCode = exitCode
    }
  } catch (err) {
    process.stderr.write(
      `error: ${args.dev ? devFailure(err, { operation: 'load', path: args.agent ?? args.dev.workspace }).message : errorMessage(err)}\n`
    )
    process.exitCode = 1
  }
}
