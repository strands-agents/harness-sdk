import { basename } from 'node:path'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ThemeProvider } from './theme.js'

import { ChatApp } from './app.js'
import type { ChatControllerApi } from '../chat/controller.js'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSnapshot } from '../chat/types.js'
import type { CliConfigStore } from '../config.js'
import type { RequestSetup, SetupChange } from '../agent-configuration.js'
import { McpTrustPrompt, type McpTrustRequest } from './mcp-trust-prompt.js'
import { SetupWizard } from './setup-wizard/index.js'
import { availableCliUpdate } from '../update-check.js'
import { readCliVersion } from '../package-version.js'
import { UpdatePrompt } from './update-prompt.js'
import { useTerminalSize } from '../terminal/size.js'
import { resolveModelTarget } from '../model/selection.js'
import type { SettingsUpdateStatus } from '../chat/panels.js'
import { ChatView } from './chat-view.js'

export type ChatLaunch = SetupChange

export interface SetupBridge {
  request: RequestSetup
  confirmMcp(workspace: string, paths: readonly string[]): Promise<boolean>
}

interface ChatRootProps {
  controller?: ChatControllerApi
  intro: boolean
  setup: boolean
  config?: CliConfigStore
  trustRequest?: McpTrustRequest
  setupBridge: SetupBridge
  onSetupComplete(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void
  /** Ends the CLI from setup when there is no harness to return to. */
  onExitSetup?(): void
  onUpdateRequested?(): void
  checkForUpdate?(): Promise<string | undefined>
  promptForUpdate?: boolean
}

export function ChatRoot({
  controller,
  intro,
  setup,
  config,
  trustRequest,
  setupBridge,
  onSetupComplete,
  onExitSetup,
  onUpdateRequested = (): void => {},
  checkForUpdate = availableCliUpdate,
  promptForUpdate = true,
}: ChatRootProps): ReactElement | null {
  const developmentCheckout = readCliVersion().includes('development')
  const [phase, setPhase] = useState<'setup' | 'chat' | 'cancelled'>(setup ? 'setup' : 'chat')
  const [availableUpdate, setAvailableUpdate] = useState<string>()
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(
    developmentCheckout ? 'development' : 'checking'
  )
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const updateTask = useRef<Promise<string | undefined> | undefined>(undefined)
  // A setup launch plays the intro in the wizard; the stale timestamp keeps the chat from replaying it.
  const introStartedAt = useRef<number | undefined>(intro ? Date.now() : undefined)
  const controllerAttached = useRef(controller !== undefined)
  // The command deck fades in once per process; later mounts (controller swap, setup return) skip it.
  const deckShown = useRef(false)
  const placeholderEntranceFade = useRef<boolean>(undefined)
  const chatEntranceFade = useRef<boolean>(undefined)
  const initialTrustInterruptedIntro = useRef(false)
  const { columns, rows } = useTerminalSize()
  if (!controllerAttached.current && trustRequest && introStartedAt.current !== undefined) {
    initialTrustInterruptedIntro.current = true
  }
  if (!controllerAttached.current && controller) {
    controllerAttached.current = true
    if (initialTrustInterruptedIntro.current) {
      introStartedAt.current = Date.now()
      initialTrustInterruptedIntro.current = false
    }
  }
  const resolveUpdate = useCallback((): Promise<string | undefined> => {
    updateTask.current ??= checkForUpdate()
    return updateTask.current
  }, [checkForUpdate])
  useEffect(() => {
    if (!config || developmentCheckout) return
    let active = true
    void resolveUpdate().then(
      (version) => {
        if (!active) return
        setAvailableUpdate(version)
        setUpdateStatus(version ? 'available' : 'current')
      },
      () => {
        if (active) setUpdateStatus('error')
      }
    )
    return (): void => {
      active = false
    }
  }, [config, developmentCheckout, resolveUpdate])
  useEffect(() => {
    setupBridge.request = (change): void => {
      if (config) {
        if (change) {
          setPhase('chat')
          onSetupComplete(0, true, change)
        } else {
          setPhase('setup')
        }
      }
    }
    return (): void => {
      setupBridge.request = (): void => {}
    }
  }, [config, onSetupComplete, setupBridge])
  function finishSetup(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void {
    setPhase(exitCode === 130 && !controller ? 'cancelled' : 'chat')
    onSetupComplete(exitCode, changed, launch)
  }

  if (phase === 'setup') {
    if (!config) {
      throw new Error('Setup requires a config store.')
    }
    if (!developmentCheckout && availableUpdate && config.snapshot().settings.updatePrompts && !updateDismissed) {
      return (
        <ThemeProvider settings={config.snapshot().settings}>
          <UpdatePrompt
            version={availableUpdate}
            manageMouseMotion
            onUpdate={onUpdateRequested}
            onLater={() => setUpdateDismissed(true)}
            onDisable={async () => {
              await config.setSettings({ updatePrompts: false })
              setUpdateDismissed(true)
              return true
            }}
          />
        </ThemeProvider>
      )
    }
    const snapshot = config.snapshot()
    // Without a running chat or a saved harness, Esc leaves the CLI instead of launching an unconfigured agent.
    const launchable = !config.needsSetup() || snapshot.agentProject !== undefined
    const escapeHint = controller
      ? 'Esc to return to chat'
      : launchable
        ? `Esc to launch ${snapshot.agentProject ? basename(snapshot.agentProject) : snapshot.profile.name}`
        : 'Esc to exit'
    return (
      <SetupWizard
        config={config}
        deferred
        escapeHint={escapeHint}
        {...(!controllerAttached.current && introStartedAt.current !== undefined
          ? { introStartedAt: introStartedAt.current }
          : {})}
        {...(!controller && !launchable && onExitSetup
          ? {
              onExit: (): void => {
                setPhase('cancelled')
                onExitSetup()
              },
            }
          : {})}
        checkForUpdate={resolveUpdate}
        onComplete={(change) => finishSetup(0, true, change)}
        onCancel={(exitCode) => finishSetup(exitCode, false)}
      />
    )
  }
  if (phase === 'cancelled') {
    return null
  }
  const settings = config?.snapshot().settings ?? DEFAULT_CHAT_SETTINGS
  if (trustRequest) {
    return (
      <ThemeProvider settings={settings}>
        <McpTrustPrompt request={trustRequest} />
      </ThemeProvider>
    )
  }
  if (!controller) {
    placeholderEntranceFade.current ??= !deckShown.current
    deckShown.current = true
    return (
      <ChatView
        snapshot={startupSnapshot(settings, config)}
        entranceFade={placeholderEntranceFade.current}
        input=""
        cursor={0}
        terminalWidth={columns}
        terminalHeight={rows}
        {...(introStartedAt.current !== undefined ? { introStartedAt: introStartedAt.current } : {})}
      />
    )
  }
  chatEntranceFade.current ??= !deckShown.current
  deckShown.current = true
  return (
    <ChatApp
      controller={controller}
      entranceFade={chatEntranceFade.current}
      {...(availableUpdate ? { availableUpdate } : {})}
      updateStatus={updateStatus}
      developmentCheckout={developmentCheckout}
      promptForUpdate={promptForUpdate && !updateDismissed && (config?.snapshot().settings.updatePrompts ?? true)}
      onDismissUpdate={() => setUpdateDismissed(true)}
      onRequestUpdate={onUpdateRequested}
      {...(introStartedAt.current !== undefined ? { introStartedAt: introStartedAt.current } : {})}
    />
  )
}

/** The model the controller will come up with, so the first frame already shows it. */
function configuredModelName(config?: CliConfigStore): string | undefined {
  const snapshot = config?.snapshot()
  if (!snapshot || snapshot.agentProject || snapshot.profile.modelModule) {
    return undefined
  }
  try {
    return resolveModelTarget(snapshot.profile.model).modelId
  } catch {
    return undefined
  }
}

function startupSnapshot(settings: ChatSettings, config?: CliConfigStore): ChatSnapshot {
  return {
    completedTurns: [],
    pendingSteering: [],
    queuedPrompts: [],
    notices: [],
    tasks: [],
    context: {},
    status: 'idle',
    runtime: {
      agent: 'Strands harness',
      version: readCliVersion(),
      backendId: 'strands',
      protocol: 'strands',
      model: configuredModelName(config) ?? 'Loading…',
      session: 'in-memory',
      cwd: process.cwd(),
      tools: [],
    },
    settings,
  }
}
