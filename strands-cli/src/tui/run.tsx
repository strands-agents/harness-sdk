import { createElement, type ReactElement } from 'react'
import { render, type Instance } from 'ink'

import { ChatRoot, type ChatLaunch, type SetupBridge } from './view/chat-root.js'
import type { ChatControllerApi, ChatConversation } from './chat/controller.js'
import type { CliConfigStore } from './config.js'
import { configurationFromStore, type RequestSetup } from './agent-configuration.js'
import { hardExitProcessTree } from './terminal/process-tree.js'
import { enterAlternateScreen } from './terminal/terminal.js'

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
  conversation?: ChatConversation,
  launch?: ChatLaunch
) => Promise<ChatControllerApi>

type ChatControllerSource = ChatControllerApi | ChatControllerFactory

const AGENT_SETUP_FIRST_REQUEST =
  'Help me set up a custom agent. Welcome me, then ask whether to start from scratch or use the detected configuration.'
const SYNCHRONIZED_OUTPUT_START = '\u001b[?2026h'
const SYNCHRONIZED_OUTPUT_END = '\u001b[?2026l'

function createInkOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  // Apple Terminal leaves stale full-screen frames when Ink emits DEC synchronized-output markers.
  return new Proxy(output, {
    get(target, property): unknown {
      if (property === 'write') {
        const write = target.write
        return (chunk: unknown, ...args: unknown[]): unknown =>
          Reflect.apply(write, target, [
            typeof chunk === 'string'
              ? chunk.replaceAll(SYNCHRONIZED_OUTPUT_START, '').replaceAll(SYNCHRONIZED_OUTPUT_END, '')
              : chunk,
            ...args,
          ])
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function runInkChat(source: ChatControllerSource, options: RunInkChatOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const inkOutput = process.env.TERM_PROGRAM === 'Apple_Terminal' ? createInkOutput(output) : output
  const alternateScreen = options.alternateScreen !== false
  const leaveTerminalMode = alternateScreen ? enterAlternateScreen(output) : (): void => {}
  const renderApp = options.renderApp ?? render
  const hardExit = (exitCode: number): never => {
    leaveTerminalMode()
    return hardExitProcessTree(exitCode)
  }
  let controller: ChatControllerApi | undefined
  let controllerFactory: ChatControllerFactory | undefined
  let instance: Instance | undefined
  const startTasks: Promise<void>[] = []
  let pendingExitCode: number | undefined
  let replacementTask: Promise<void> | undefined
  let launchOptions: ChatLaunch | undefined
  const setupBridge: SetupBridge = { request: (): void => {} }
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
        const conversation =
          launch?.assistant || launch?.newConversation
            ? undefined
            : await previousController.captureConversation?.(launch?.conversationId)
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
          errorOutput.write(`error: Failed to apply setup: ${message}\n`)
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
              startTasks.push(
                launch?.assistant
                  ? controller.start(AGENT_SETUP_FIRST_REQUEST, { hidePrompt: true })
                  : controller.start()
              )
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
        launch
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
  const introState: { exitCode?: 0 | 130 } = options.intro === false ? { exitCode: 0 } : {}
  let resolveIntro: (exitCode: 0 | 130) => void = () => {}
  const introTask =
    options.intro === false
      ? Promise.resolve<0 | 130>(0)
      : new Promise<0 | 130>((resolve) => {
          resolveIntro = resolve
        })
  const completeIntro = (exitCode: 0 | 130): void => {
    introState.exitCode = exitCode
    resolveIntro(exitCode)
    if (exitCode !== 0) {
      closeForExit(exitCode)
    }
  }
  const chatRoot = (): ReactElement =>
    createElement(ChatRoot, {
      ...(controller ? { controller } : {}),
      intro: options.intro !== false,
      setup: options.setup === true,
      ...(options.config ? { config: options.config } : {}),
      setupBridge,
      onSetupComplete: completeSetup,
      onIntroComplete: completeIntro,
    })

  const onSigint = (): void => closeForExit(130)
  const onSigterm = (): void => closeForExit(143)
  const onSighup = (): void => closeForExit(129)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)

  try {
    if (typeof source === 'function') {
      controllerFactory = source
    } else {
      controller = source
    }
    instance = renderApp(chatRoot(), {
      stdin: input,
      stdout: inkOutput,
      stderr: errorOutput,
      exitOnCtrlC: false,
      patchConsole: true,
      // Full-frame repaints flash on terminals that ignore or lack synchronized output.
      incrementalRendering: true,
      maxFps: 30,
    })
    const setupExit = await setupTask
    if (setupExit !== 0) {
      instance.unmount()
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
      instance.rerender(chatRoot())
    }
    if (!controller) {
      throw new Error('Controller initialization did not return a controller.')
    }
    if (introState.exitCode === 130) {
      controller.close(introState.exitCode)
      instance.unmount()
      await instance.waitUntilExit()
      return introState.exitCode
    }
    startTasks.push(
      launchOptions?.assistant
        ? controller.start(AGENT_SETUP_FIRST_REQUEST, { hidePrompt: true })
        : controller.start(options.firstRequest)
    )
    const introExit = await introTask
    if (introExit !== 0) {
      controller.close(introExit)
      instance.unmount()
      await instance.waitUntilExit()
      return introExit
    }
    await instance.waitUntilExit()
    return controller.getSnapshot().exitCode ?? 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
    instance?.unmount()
    instance?.cleanup()
    leaveTerminalMode()

    const hardExitCode = controller?.hardExitCode
    if (hardExitCode !== undefined) {
      void controller?.dispose()
      hardExit(hardExitCode)
    }
    await Promise.allSettled([...startTasks, replacementTask, controller?.dispose()])
  }
}
