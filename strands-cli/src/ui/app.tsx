import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Box, useInput } from 'ink'
import { sanitizeTerminalText } from '../terminal/text.js'
import { Text, useTheme, ThemeProvider } from './theme.js'
import { basename } from 'node:path'
import { ChatApp } from './chat/screen.js'
import { type ChatControllerApi } from './chat/controller.js'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSnapshot } from './chat/types.js'
import { type CliConfigStore } from '../config/store.js'
import { type RequestSetup, type SetupChange } from '../agent/configuration.js'
import type { ChatConfigurationProject } from '../agent/types.js'
import { SetupWizard } from './setup/wizard.js'
import { availableCliUpdate } from '../cli/update.js'
import { readCliVersion } from '../package-version.js'
import { UpdatePrompt } from './update.js'
import { useTerminalSize } from './terminal-size.js'
import { resolveModelTarget } from '../model/selection.js'
import { type SettingsUpdateStatus } from './chat/panel-state.js'
import { ChatView } from './chat/view.js'

export interface McpTrustRequest {
  workspace: string
  paths: readonly string[]
  resolve(trusted: boolean): void
}

/** Asks inside Ink: a readline prompt would drop the raw mode Ink's input relies on. */
export function McpTrustPrompt({ request }: { request: McpTrustRequest }): ReactElement {
  const { accent } = useTheme()
  useInput((character, key) => {
    if (key.ctrl || key.meta) return
    const answer = character.toLowerCase()
    if (answer === 'y') request.resolve(true)
    else if (answer === 'n' || key.escape || key.return) request.resolve(false)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={accent}>
        Trust this project&apos;s MCP configuration?
      </Text>
      <Text dimColor>{sanitizeTerminalText(`Found in ${request.workspace}:`)}</Text>
      {request.paths.map((path) => (
        <Text key={path}>{sanitizeTerminalText(`  ${path}`)}</Text>
      ))}
      <Text dimColor>Trusting lets its MCP commands run.</Text>
      <Text> </Text>
      <Text dimColor>y trust · n / Enter skip</Text>
    </Box>
  )
}

export type ChatLaunch = SetupChange

export interface SetupBridge {
  request: RequestSetup
  confirmMcp(workspace: string, paths: readonly string[]): Promise<boolean>
}

interface ChatRootProps {
  startupContent?: ReactNode
  startupStatus?: string
  controller?: ChatControllerApi
  intro: boolean
  setup: boolean
  config?: CliConfigStore
  trustRequest?: McpTrustRequest
  setupBridge: SetupBridge
  onSetupComplete(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void
  onExitSetup(exitCode: 0 | 130): void
  onUpdateRequested?(): void
  checkForUpdate?(): Promise<string | undefined>
  promptForUpdate?: boolean
  openProject?: (project: ChatConfigurationProject) => Promise<void>
}

export function ChatRoot({
  startupContent,
  startupStatus,
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
  openProject,
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
            onExit={(exitCode) => {
              setPhase('cancelled')
              onExitSetup(exitCode)
            }}
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
    const hasSavedHarness = !config.needsSetup() || snapshot.agentProject !== undefined
    const escapeHint = controller
      ? 'Esc to return to chat'
      : hasSavedHarness
        ? `Esc to launch ${snapshot.agentProject ? basename(snapshot.agentProject) : snapshot.profile.name}`
        : 'Esc to open chat'
    return (
      <SetupWizard
        config={config}
        deferred
        escapeHint={sanitizeTerminalText(escapeHint)}
        {...(!controllerAttached.current && introStartedAt.current !== undefined
          ? { introStartedAt: introStartedAt.current }
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
        snapshot={{ ...startupSnapshot(settings, config), ...(startupStatus ? { composerStatus: startupStatus } : {}) }}
        {...(startupContent ? { startupContent } : {})}
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
      {...(openProject ? { openProject } : {})}
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
    composerStatus: 'Starting agent…',
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
