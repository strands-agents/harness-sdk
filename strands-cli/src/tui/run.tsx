import { createElement, type ComponentProps, type ReactElement } from 'react'
import { render, useInput, type Instance } from 'ink'

import { ChatRoot, type ChatLaunch, type SetupBridge } from './view/chat-root.js'
import type { McpTrustRequest } from './view/mcp-trust-prompt.js'
import type { ChatControllerApi, ChatConversation } from './chat/controller.js'
import type { CliConfigStore } from './config.js'
import { configurationFromStore, type RequestSetup } from './agent-configuration.js'
import { hardExitProcessTree } from './terminal/process-tree.js'
import { createInkOutputs, enterAlternateScreen } from './terminal/terminal.js'

interface RunInkChatOptions {
  firstRequest?: string
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  errorOutput?: NodeJS.WriteStream
  alternateScreen?: boolean
  intro?: boolean
  setup?: boolean
  config?: CliConfigStore
  renderApp?: typeof render
}

type ChatControllerFactory = (
  signal: AbortSignal,
  requestSetup: RequestSetup,
  conversation: ChatConversation | undefined,
  launch: ChatLaunch | undefined,
  confirmMcp: SetupBridge['confirmMcp']
) => Promise<ChatControllerApi>

type ChatControllerSource = ChatControllerApi | ChatControllerFactory

function ChatSession({
  onCancelStartup,
  ...props
}: ComponentProps<typeof ChatRoot> & { onCancelStartup(): void }): ReactElement {
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') onCancelStartup()
    },
    { isActive: props.trustRequest !== undefined }
  )
  return createElement(ChatRoot, props)
}

export async function runInkChat(source: ChatControllerSource, options: RunInkChatOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const alternateScreen = options.alternateScreen !== false
  const inkOutputs = createInkOutputs(output, errorOutput, alternateScreen)
  let leaveTerminalMode = (): void => {}
  const renderApp = options.renderApp ?? render
  const hardExit = (exitCode: number): never => {
    restoreTerminal()
    return hardExitProcessTree(exitCode)
  }
  let controller: ChatControllerApi | undefined
  let controllerFactory: ChatControllerFactory | undefined
  let instance: Instance | undefined
  let terminalRestored = false
  const restoreTerminal = (): void => {
    if (terminalRestored) return
    terminalRestored = true
    process.off('exit', restoreTerminal)
    try {
      // React cleanup can enable mouse reporting, so unmount before resetting the terminal.
      instance?.unmount()
      instance?.cleanup()
    } finally {
      leaveTerminalMode()
    }
  }
  const startTasks: Promise<void>[] = []
  let pendingExitCode: number | undefined
  let replacementTask: Promise<void> | undefined
  let launchOptions: ChatLaunch | undefined
  let trustRequest: McpTrustRequest | undefined
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
  const setupTask = options.setup
    ? new Promise<0 | 130>((resolve) => {
        resolveSetup = resolve
      })
    : Promise.resolve<0 | 130>(0)
  const completeSetup = (exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void => {
    if (changed && !controller) launchOptions = launch
    resolveSetup(exitCode)
    if (exitCode === 0 && changed && controller && controllerFactory && instance && !replacementTask) {
      const previousController = controller
      const resumeVoiceInput = previousController.pauseVoiceInput?.()
      controller = undefined
      instance.rerender(chatRoot())
      replacementTask = (async (): Promise<void> => {
        const conversation = await previousController.captureConversation?.(launch?.conversationId)
        const replacement = await initializeController(launch, conversation)
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
          inkOutputs.stderr.write(`error: Failed to apply setup: ${message}\n`)
          controller = previousController
          previousController.showError?.('Setup failed', message)
          if (pendingExitCode !== undefined) {
            await previousController.dispose()
          }
        })
        .finally(() => {
          replacementTask = undefined
          if (pendingExitCode === undefined && controller) {
            instance!.rerender(chatRoot())
            if (controller !== previousController) {
              startTasks.push(controller.start())
            }
            resumeVoiceInput?.(controller)
          }
        })
    }
  }
  const startupAbort = new AbortController()
  const initializeController = async (
    launch?: ChatLaunch,
    conversation?: ChatConversation
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
        conversation,
        launch,
        (workspace, paths) => setupBridge.confirmMcp(workspace, paths)
      )
      startupAbort.signal.throwIfAborted()
      if (launch?.configuration) {
        await config!.saveSetup(launch.configuration, { agentProject: launch.agentProject })
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
  const chatRoot = (): ReactElement =>
    createElement(ChatSession, {
      ...(controller ? { controller } : {}),
      intro: options.intro !== false,
      setup: options.setup === true,
      ...(options.config ? { config: options.config } : {}),
      ...(trustRequest ? { trustRequest } : {}),
      setupBridge,
      onSetupComplete: completeSetup,
      onCancelStartup: () => closeForExit(130),
    })
  const renderChat = (): void => {
    if (instance) {
      instance.rerender(chatRoot())
      return
    }
    if (alternateScreen) leaveTerminalMode = enterAlternateScreen(output)
    instance = renderApp(chatRoot(), {
      stdin: input,
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
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)
  process.once('exit', restoreTerminal)

  try {
    if (typeof source === 'function') {
      controllerFactory = source
    } else {
      controller = source
    }
    if (controller || options.setup) renderChat()
    const setupExit = await setupTask
    if (setupExit !== 0) {
      instance?.unmount()
      return setupExit
    }
    if (controllerFactory) {
      const controllerTask = initializeController(launchOptions)
      const startupResult = await Promise.race([
        controllerTask.then((initializedController) => ({ controller: initializedController })),
        startupExitTask.then((exitCode) => ({ exitCode })),
      ])
      if ('exitCode' in startupResult) {
        void controllerTask.then(
          async (lateController) => {
            lateController.close(startupResult.exitCode)
            await lateController.dispose()
          },
          () => {}
        )
        return hardExit(startupResult.exitCode)
      }
      controller = startupResult.controller
      if (pendingExitCode !== undefined) {
        controller.close(pendingExitCode)
        return pendingExitCode
      }
      renderChat()
    }
    if (!controller) {
      throw new Error('Controller initialization did not return a controller.')
    }
    startTasks.push(controller.start(options.firstRequest))
    await instance!.waitUntilExit()
    return controller.getSnapshot().exitCode ?? 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
    restoreTerminal()

    const hardExitCode = controller?.hardExitCode
    if (hardExitCode !== undefined) {
      void controller?.dispose()
      hardExit(hardExitCode)
    }
    await Promise.allSettled([...startTasks, replacementTask, controller?.dispose()])
  }
}
