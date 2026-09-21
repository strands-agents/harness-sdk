import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useInput } from 'ink'
import { Text, ThemeProvider } from './theme.js'

import { ChatApp } from './app.js'
import type { ChatControllerApi } from '../chat/controller.js'
import { DEFAULT_CHAT_SETTINGS } from '../chat/types.js'
import type { CliConfigStore } from '../config.js'
import type { AgentSetupSelection, RequestSetup, SetupChange } from '../agent-configuration.js'
import { DnaVortexIntro } from './intro.js'
import { SetupWizard } from './setup-wizard/index.js'

export interface ChatLaunch extends SetupChange {
  assistant?: AgentSetupSelection
}

export interface SetupBridge {
  request: RequestSetup
}

interface ChatRootProps {
  controller?: ChatControllerApi
  intro: boolean
  setup: boolean
  config?: CliConfigStore
  setupBridge: SetupBridge
  onSetupComplete(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void
  onIntroComplete(exitCode: 0 | 130): void
}

export function ChatRoot({
  controller,
  intro,
  setup,
  config,
  setupBridge,
  onSetupComplete,
  onIntroComplete,
}: ChatRootProps): ReactElement | null {
  const [phase, setPhase] = useState<'setup' | 'intro' | 'chat' | 'cancelled'>(
    intro ? 'intro' : setup ? 'setup' : 'chat'
  )
  const [awaitingAssistant, setAwaitingAssistant] = useState(false)
  const assistantController = useRef<ChatControllerApi | undefined>(undefined)
  const assistantControllerGap = useRef(false)
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
  useEffect(() => {
    if (!awaitingAssistant) {
      return
    }
    if (!controller) {
      assistantControllerGap.current = true
      return
    }
    if (assistantControllerGap.current || controller !== assistantController.current) {
      setAwaitingAssistant(false)
      setPhase('chat')
    }
  }, [awaitingAssistant, controller])
  function finishSetup(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void {
    const launchingAssistant = exitCode === 0 && launch?.assistant !== undefined
    if (launchingAssistant) {
      assistantController.current = controller
      assistantControllerGap.current = controller === undefined
      setAwaitingAssistant(true)
    } else {
      setPhase(exitCode === 130 && !controller ? 'cancelled' : 'chat')
    }
    onSetupComplete(exitCode, changed, launch)
  }
  const finishIntro = useCallback(
    (exitCode: 0 | 130): void => {
      setPhase(exitCode === 0 ? (setup ? 'setup' : 'chat') : 'cancelled')
      onIntroComplete(exitCode)
      if (exitCode === 130 && setup) {
        onSetupComplete(exitCode, false)
      }
    },
    [onIntroComplete, onSetupComplete, setup]
  )
  useInput((character, key) => {
    if (phase !== 'intro') {
      return
    }
    if (character === ' ' && !key.ctrl && !key.meta && !key.super) {
      finishIntro(0)
    } else if (key.ctrl && (character === 'c' || character === 'd')) {
      finishIntro(130)
    }
  })

  if (phase === 'setup') {
    if (!config) {
      throw new Error('Setup requires a config store.')
    }
    return (
      <SetupWizard
        config={config}
        deferred
        onComplete={(change) => finishSetup(0, true, change)}
        onCancel={(exitCode) => finishSetup(exitCode, false)}
        onAgentSetup={(assistant) => finishSetup(0, true, { assistant })}
      />
    )
  }
  if (phase === 'intro') {
    const settings = config?.snapshot().settings ?? DEFAULT_CHAT_SETTINGS
    return (
      <ThemeProvider settings={settings}>
        <DnaVortexIntro
          ready={setup || controller !== undefined}
          theme={settings.frogTheme}
          customBase={settings.customTheme.base}
          onComplete={finishIntro}
        />
      </ThemeProvider>
    )
  }
  if (phase === 'cancelled') {
    return null
  }
  return controller ? <ChatApp controller={controller} /> : <Text dimColor>Starting Strands harness...</Text>
}
