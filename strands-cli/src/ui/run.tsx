import { createElement, type ComponentProps, type ReactElement } from 'react'
import { render, useInput, type Instance } from 'ink'

import { ChatRoot, type ChatLaunch, type SetupBridge, type McpTrustRequest } from './app.js'
import type { ChatControllerApi } from './chat/controller.js'
import type { ChatConversations, ChatConfigurationProject } from '../agent/types.js'
import type { CliConfigStore } from '../config/store.js'
import { configurationFromStore, type RequestSetup, type WorkspaceAction } from '../agent/configuration.js'
import { hardExitProcessTree } from '../terminal/process-tree.js'
import { openAgentProject } from '../terminal/open-editor.js'
import {
  createInkOutputs,
  enterAlternateScreen,
  restoreTerminalModes,
  saveTerminalTitle,
  setTerminalTitle,
  setTerminalMouseMotion,
} from '../terminal/terminal.js'
import { observeTerminalColorMode } from '../terminal/theme-detection.js'
import { sessionResumeCommand } from '../session/sessions.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import { devFailure } from '../dev/errors.js'

export interface StartupScreen {
  signal: AbortSignal
  show(content: ReactElement | undefined, status?: string): void
  openProject?(project: ChatConfigurationProject): Promise<void>
}

export interface WorkspaceChange {
  apply(): Promise<void>
  rollback(): Promise<void>
  finish(): Promise<void>
}

interface RunInkChatOptions {
  exitAfterInitialization?: boolean
  onWorkspaceAction?: (action: WorkspaceAction, screen: StartupScreen) => Promise<WorkspaceChange | undefined>
  prepare?: (screen: StartupScreen) => Promise<boolean>
  recoverStartup?: (error: unknown, screen: StartupScreen) => Promise<'retry' | 'back' | 'exit'>
  firstRequest?: string
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  errorOutput?: NodeJS.WriteStream
  alternateScreen?: boolean
  intro?: boolean
  setup?: boolean
  config?: CliConfigStore
  renderApp?: typeof render
  checkForUpdate?: () => Promise<string | undefined>
  onUpdateRequested?: () => void
}

type ChatControllerFactory = (
  signal: AbortSignal,
  requestSetup: RequestSetup,
  conversations: ChatConversations | undefined,
  launch: ChatLaunch | undefined,
  confirmMcp: SetupBridge['confirmMcp']
) => Promise<ChatControllerApi>

type ChatControllerSource = ChatControllerApi | ChatControllerFactory

/** Keeps the previous chat on screen, read-only, while its replacement starts. */
function reloadingController(previous: ChatControllerApi, close: (exitCode: number) => void): ChatControllerApi {
  const snapshot = { ...previous.getSnapshot(), composerStatus: 'Reloading agent...' }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    busy: false,
    hardExitCode: undefined,
    actionableCommandToken: () => undefined,
    start: async (): Promise<void> => {},
    submit: async () => undefined,
    steer: async () => undefined,
    updateQueuedPrompt: () => false,
    removeQueuedPrompt: () => false,
    moveQueuedPrompt: () => false,
    cancel: () => false,
    close,
    dispose: async (): Promise<void> => {},
    dismissPanel: () => false,
    activatePanelRow: async () => false,
    openSkillDetail: () => false,
    openMcpDetail: () => false,
    retryMcpServer: async () => false,
    openModelPanel: async (): Promise<void> => {},
    openContextPanel: (): void => {},
  }
}

function ChatSession({
  onCancelStartup,
  ...props
}: ComponentProps<typeof ChatRoot> & { onCancelStartup(): void }): ReactElement {
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') onCancelStartup()
    },
    { isActive: props.trustRequest !== undefined || (!props.controller && !props.setup) }
  )
  return createElement(ChatRoot, props)
}

export async function runInkChat(source: ChatControllerSource, options: RunInkChatOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const terminalTheme = observeTerminalColorMode(input, output)
  const alternateScreen = options.alternateScreen !== false
  const inkOutputs = createInkOutputs(output, errorOutput, alternateScreen)
  let leaveTerminalMode = (): void => {}
  let restoreTerminalTitle = (): void => {}
  let stopWatchingTitle = (): void => {}
  let terminalTitle: string | undefined
  const watchTerminalTitle = (active: ChatControllerApi): void => {
    stopWatchingTitle()
    const update = (): void => {
      const title = active.getSnapshot().runtime.sessionName ?? 'Strands'
      if (title === terminalTitle) return
      terminalTitle = title
      setTerminalTitle(title, output)
    }
    stopWatchingTitle = active.subscribe(update)
    update()
  }
  const renderApp = options.renderApp ?? render
  const hardExit = (exitCode: number): never => {
    cleanup()
    return hardExitProcessTree(exitCode)
  }
  let controller: ChatControllerApi | undefined
  let reloading: ChatControllerApi | undefined
  let controllerFactory: ChatControllerFactory | undefined
  let instance: Instance | undefined
  const startTasks: Promise<void>[] = []
  let pendingExitCode: number | undefined
  let replacementTask: Promise<void> | undefined
  let launchOptions: ChatLaunch | undefined
  let trustRequest: McpTrustRequest | undefined
  let startupContent: ReactElement | undefined
  let startupStatus: string | undefined
  const setupBridge: SetupBridge = {
    request: (): void => {},
    confirmMcp: (workspace, paths): Promise<boolean> =>
      new Promise((resolve) => {
        trustRequest = {
          workspace,
          paths,
          resolve: (trusted): void => {
            trustRequest = undefined
            resolve(trusted)
          },
        }
        renderChat()
      }),
  }
  let resolveSetup: (exitCode: 0 | 130) => void = () => {}
  let exitAfterSetup = false
  const setupTask = options.setup
    ? new Promise<0 | 130>((resolve) => {
        resolveSetup = resolve
      })
    : Promise.resolve<0 | 130>(0)
  const changeWorkspace = async (action: WorkspaceAction): Promise<void> => {
    const previous = controller
    if (!previous || !options.onWorkspaceAction) return
    let disposed = false
    let change: WorkspaceChange | undefined
    let conversations: ChatConversations | undefined
    let pendingController: ChatControllerApi | undefined
    const resumeVoice = previous.pauseVoiceInput?.()
    controller = undefined
    stopWatchingTitle()
    renderChat()
    try {
      change = await options.onWorkspaceAction(action, {
        signal: startupAbort.signal,
        show: (content, status): void => {
          startupContent = content
          startupStatus = status
          renderChat()
        },
        openProject: async (project): Promise<void> => {
          leaveTerminalMode()
          restoreTerminalModes(output)
          const wasRaw = input.isRaw
          try {
            if (input.isTTY) input.setRawMode(false)
            await openAgentProject(project)
          } finally {
            if (input.isTTY && wasRaw) input.setRawMode(true)
            if (!cleanedUp && alternateScreen) leaveTerminalMode = enterAlternateScreen(output)
          }
        },
      })
      if (!change || startupAbort.signal.aborted) {
        if (change) await change.rollback()
        controller = previous
        return
      }
      conversations = await previous.captureConversations?.()
      await previous.dispose()
      disposed = true
      controller = undefined
      await change.apply()
      const replacement = await initializeController()
      pendingController = replacement
      startupAbort.signal.throwIfAborted()
      controller = replacement
      try {
        await change.finish()
      } catch (error) {
        replacement.showError?.('Workspace backup retained', error instanceof Error ? error.message : String(error))
      }
      startTasks.push(replacement.start())
      pendingController = undefined
    } catch (error) {
      if (pendingController) await pendingController.dispose()
      let message = error instanceof Error ? error.message : String(error)
      if (change && disposed) {
        try {
          await change.rollback()
          if (!startupAbort.signal.aborted) {
            controller = await initializeController(undefined, conversations)
            startTasks.push(controller.start())
          }
        } catch (restoreError) {
          message += `\nRestore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        }
      } else {
        controller = previous
      }
      controller?.showError?.('Workspace unchanged', message)
      if (!controller && !startupAbort.signal.aborted) {
        inkOutputs.stderr.write(`error: ${message}\n`)
        closeForExit(1)
      }
    } finally {
      startupContent = undefined
      startupStatus = undefined
      replacementTask = undefined
      if (!disposed) resumeVoice?.()
      if (controller && !cleanedUp) {
        watchTerminalTitle(controller)
        renderChat()
      }
    }
  }
  const completeSetup = (exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void => {
    if (launch && 'workspaceAction' in launch) {
      if (options.onWorkspaceAction && !replacementTask) replacementTask = changeWorkspace(launch.workspaceAction)
      return
    }
    if (changed && !controller) launchOptions = launch
    resolveSetup(exitCode)
    if (exitCode === 0 && changed && controller && controllerFactory && instance && !replacementTask) {
      const previousController = controller
      previousController.clearReloadStatus?.()
      const resumeVoiceInput = previousController.pauseVoiceInput?.()
      controller = undefined
      reloading = reloadingController(previousController, closeForExit)
      instance.rerender(chatRoot())
      replacementTask = (async (): Promise<void> => {
        const conversations = await previousController.captureConversations?.()
        const replacement = await initializeController(launch, conversations)
        if (launch?.reloadedFiles && conversations) replacement.markReloaded?.(launch.reloadedFiles)
        await Promise.allSettled([previousController.dispose()])
        if (pendingExitCode !== undefined) {
          replacement.close(pendingExitCode)
          await replacement.dispose()
          return
        }
        controller = replacement
      })()
        .catch(async (error: unknown) => {
          let message = error instanceof Error ? error.message : String(error)
          try {
            await launch?.onFailure?.(message)
          } catch (recordingError) {
            message += `\nCould not save the setup failure: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}`
          }
          const workspace = previousController.getSnapshot().runtime.devWorkspace
          if (workspace) {
            const failure = devFailure(error, { operation: 'reload', path: workspace.entrypoint })
            previousController.showError?.('Agent reload failed', failure.message)
          } else {
            inkOutputs.stderr.write(`error: Failed to apply setup: ${sanitizeTerminalText(message)}\n`)
            previousController.showError?.('Setup failed', message)
          }
          controller = previousController
          if (pendingExitCode !== undefined) {
            await previousController.dispose()
          }
        })
        .finally(() => {
          replacementTask = undefined
          reloading = undefined
          resumeVoiceInput?.()
          if (pendingExitCode === undefined && controller) {
            watchTerminalTitle(controller)
            instance!.rerender(chatRoot())
            if (controller !== previousController) {
              startTasks.push(controller.start())
            }
          }
        })
    }
  }
  const startupAbort = new AbortController()
  const initializeController = async (
    launch?: ChatLaunch,
    conversations?: ChatConversations
  ): Promise<ChatControllerApi> => {
    const config = options.config
    const previous = config?.snapshot()
    const previousConfiguration = config && launch?.configuration ? configurationFromStore(config) : undefined
    let replacement: ChatControllerApi | undefined
    try {
      startupAbort.signal.throwIfAborted()
      if (launch?.configuration) {
        if (!config) throw new Error('Configuration is unavailable.')
        // The factory reads this store; keep the saved definition intact until it succeeds.
        await config.saveSetup(launch.configuration, { agentProject: launch.agentProject, persist: false })
      }
      replacement = await controllerFactory!(
        startupAbort.signal,
        (change) => setupBridge.request(change),
        conversations,
        launch,
        (workspace, paths) => setupBridge.confirmMcp(workspace, paths)
      )
      startupAbort.signal.throwIfAborted()
      if (launch?.configuration) {
        await config!.saveSetup(launch.configuration, { agentProject: launch.agentProject })
      } else if (launch?.profile) {
        if (!config) throw new Error('Configuration is unavailable.')
        await config.saveProfile(launch.profile)
      }
      return replacement
    } catch (error) {
      await Promise.allSettled([replacement?.dispose()])
      if (previousConfiguration) {
        await config!.saveSetup(previousConfiguration, {
          onboardingVersion: previous!.onboarding.version,
          agentProject: previous!.agentProject,
          persist: false,
        })
        config!.applyProviderEnvironment()
      }
      throw error
    }
  }
  let resolveStartupExit: (exitCode: number) => void
  const startupExitTask = new Promise<number>((resolve) => {
    resolveStartupExit = resolve
  })
  const closeForExit = (exitCode: number): void => {
    pendingExitCode ??= exitCode
    if (!startupAbort.signal.aborted) {
      startupAbort.abort(new Error(`Startup cancelled with exit code ${pendingExitCode}.`))
      resolveStartupExit(pendingExitCode)
    }
    controller?.close(pendingExitCode)
    instance?.unmount()
  }
  const chatRoot = (): ReactElement => {
    const shown = controller ?? reloading
    return createElement(ChatSession, {
      ...(shown ? { controller: shown } : {}),
      intro: options.intro !== false,
      setup: options.setup === true,
      ...(options.config ? { config: options.config } : {}),
      ...(trustRequest ? { trustRequest } : {}),
      ...(startupContent ? { startupContent } : {}),
      ...(startupStatus ? { startupStatus } : {}),
      setupBridge,
      onSetupComplete: completeSetup,
      ...(options.checkForUpdate ? { checkForUpdate: options.checkForUpdate } : {}),
      promptForUpdate: options.firstRequest === undefined,
      onExitSetup: (exitCode) => {
        exitAfterSetup = true
        resolveSetup(exitCode)
        closeForExit(exitCode)
      },
      onUpdateRequested: () => {
        options.onUpdateRequested?.()
        resolveSetup(130)
        closeForExit(0)
      },
      onCancelStartup: () => closeForExit(130),
      openProject: async (project): Promise<void> => {
        leaveTerminalMode()
        restoreTerminalModes(output)
        const wasRaw = input.isRaw
        try {
          if (input.isTTY) input.setRawMode(false)
          await openAgentProject(project)
        } finally {
          if (input.isTTY && wasRaw) input.setRawMode(true)
          if (!cleanedUp) {
            if (alternateScreen) leaveTerminalMode = enterAlternateScreen(output)
            setTerminalMouseMotion(true, output)
          }
        }
      },
    })
  }
  const renderChat = (): void => {
    if (instance) {
      instance.rerender(chatRoot())
      return
    }
    if (alternateScreen) leaveTerminalMode = enterAlternateScreen(output)
    instance = renderApp(chatRoot(), {
      stdin: terminalTheme.input,
      ...inkOutputs,
      exitOnCtrlC: false,
      patchConsole: true,
      // Full-frame repaints flash on terminals that ignore or lack synchronized output.
      incrementalRendering: true,
      maxFps: 30,
    })
  }

  const onSigint = (): void => closeForExit(130)
  const onSigterm = (): void => closeForExit(143)
  const onSighup = (): void => closeForExit(129)
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
    process.off('exit', onProcessExit)
    process.off('uncaughtExceptionMonitor', onProcessExit)
    for (const restore of [
      (): void => instance?.unmount(),
      (): void => instance?.cleanup(),
      stopWatchingTitle,
      leaveTerminalMode,
      restoreTerminalTitle,
      terminalTheme.dispose,
      (): void => restoreTerminalModes(output),
    ]) {
      try {
        restore()
      } catch {
        // Try every restoration step without replacing the original crash or exit status.
      }
    }
  }
  const onProcessExit = (reason: number | Error): void => {
    // The SDK's signal handler can call process.exit(0) before our shutdown completes.
    if (reason === 0 && pendingExitCode) process.exitCode = pendingExitCode
    cleanup()
  }
  process.prependListener('SIGINT', onSigint)
  process.prependListener('SIGTERM', onSigterm)
  process.prependListener('SIGHUP', onSighup)
  process.on('exit', onProcessExit)
  // Restore the primary screen before Node prints an uncaught exception.
  process.on('uncaughtExceptionMonitor', onProcessExit)

  try {
    await terminalTheme.ready
    if (pendingExitCode !== undefined) return pendingExitCode
    restoreTerminalTitle = saveTerminalTitle(output)
    if (typeof source === 'function') {
      controllerFactory = source
    } else {
      controller = source
      watchTerminalTitle(controller)
    }
    if (controller || controllerFactory || options.setup || options.prepare) renderChat()
    const screen: StartupScreen = {
      signal: startupAbort.signal,
      show: (content, status): void => {
        if (startupAbort.signal.aborted) return
        startupContent = content
        startupStatus = status
        renderChat()
      },
    }
    const prepareStartup = async (): Promise<boolean> => {
      if (!options.prepare) return true
      const prepared = await Promise.race([
        options.prepare(screen).then((ready) => ({ ready })),
        startupExitTask.then((exitCode) => ({ exitCode })),
      ])
      return !('exitCode' in prepared) && prepared.ready
    }
    if (options.prepare) {
      if (!(await prepareStartup())) return pendingExitCode ?? 0
      startupContent = undefined
      startupStatus = undefined
      renderChat()
    }
    const setupExit = await Promise.race([setupTask, startupExitTask])
    if (setupExit !== 0 || exitAfterSetup) {
      instance?.unmount()
      return setupExit
    }
    if (controllerFactory) {
      const initializeWithRecovery = async (): Promise<ChatControllerApi | undefined> => {
        let initialized: ChatControllerApi | undefined
        while (!initialized) {
          try {
            initialized = await initializeController(launchOptions)
          } catch (error) {
            if (!options.recoverStartup || startupAbort.signal.aborted) throw error
            const action = await options.recoverStartup(error, screen)
            if (action === 'exit') return undefined
            if (action === 'back' && !(await prepareStartup())) return undefined
          }
        }
        return initialized
      }
      const controllerTask = initializeWithRecovery()
      const startupResult = await Promise.race([
        controllerTask.then((initializedController) => ({ controller: initializedController })),
        startupExitTask.then((exitCode) => ({ exitCode })),
      ])
      if ('exitCode' in startupResult) {
        void controllerTask.then(
          async (lateController) => {
            lateController?.close(startupResult.exitCode)
            await lateController?.dispose()
          },
          () => {}
        )
        return hardExit(startupResult.exitCode)
      }
      controller = startupResult.controller
      if (!controller) return pendingExitCode ?? 0
      startupContent = undefined
      startupStatus = undefined
      if (pendingExitCode !== undefined) {
        controller.close(pendingExitCode)
        return pendingExitCode
      }
      watchTerminalTitle(controller)
      renderChat()
    }
    if (!controller) {
      throw new Error('Controller initialization did not return a controller.')
    }
    if (options.exitAfterInitialization) return 0
    startTasks.push(controller.start(options.firstRequest))
    await instance!.waitUntilExit()
    return pendingExitCode ?? controller?.getSnapshot().exitCode ?? 0
  } finally {
    cleanup()

    const resumeSession = controller?.resumeSession
    if (resumeSession && controller?.getSnapshot().status === 'closed') {
      await new Promise<void>((resolve) => {
        output.write(`\nResume with: ${sessionResumeCommand(resumeSession)}\n`, () => resolve())
      })
    }

    const hardExitCode = controller?.hardExitCode
    if (hardExitCode !== undefined) {
      void controller?.dispose()
      hardExit(hardExitCode)
    }
    await Promise.allSettled([...startTasks, replacementTask, controller?.dispose()])
  }
}
