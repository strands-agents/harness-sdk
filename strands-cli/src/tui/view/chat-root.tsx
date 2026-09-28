import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useInput } from 'ink'
import { Text, ThemeProvider } from './theme.js'

import { ChatApp } from './app.js'
import type { ChatControllerApi } from '../chat/controller.js'
import { DEFAULT_CHAT_SETTINGS } from '../chat/types.js'
import type { CliConfigStore } from '../config.js'
import type { RequestSetup, SetupChange } from '../agent-configuration.js'
import { DnaVortexIntro } from './intro.js'
import { McpTrustPrompt, type McpTrustRequest } from './mcp-trust-prompt.js'
import { SetupWizard } from './setup-wizard/index.js'

const LOADING_DOT_FRAMES = ['.  ', '.. ', '...'] as const

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
  setupBridge: SetupBridge
  onSetupComplete(exitCode: 0 | 130, changed: boolean, launch?: ChatLaunch): void
  onIntroComplete(exitCode: 0 | 130): void
}

function StartingHarness({ animate }: { animate: boolean }): ReactElement {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!animate) {
      return
    }
    const timer = setInterval(() => setFrame((current) => current + 1), 350)
    return (): void => clearInterval(timer)
  }, [animate])
  return (
    <Text dimColor>
      Starting Strands harness{animate ? LOADING_DOT_FRAMES[frame % LOADING_DOT_FRAMES.length] : '...'}
    </Text>
  )
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
  const [trustRequest, setTrustRequest] = useState<McpTrustRequest>()
  useEffect(() => {
    setupBridge.confirmMcp = (workspace, paths): Promise<boolean> =>
      new Promise((resolve) => {
        setTrustRequest({
          workspace,
          paths,
          resolve: (trusted): void => {
            setTrustRequest(undefined)
            resolve(trusted)
          },
        })
      })
    return (): void => {
      setupBridge.confirmMcp = async (): Promise<boolean> => false
    }
  }, [setupBridge])
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
      />
    )
  }
  if (phase === 'intro') {
    const settings = config?.snapshot().settings ?? DEFAULT_CHAT_SETTINGS
    return (
      <ThemeProvider settings={settings}>
        <DnaVortexIntro
          ready={setup || controller !== undefined}
          setup={setup}
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
  const settings = config?.snapshot().settings ?? DEFAULT_CHAT_SETTINGS
  if (trustRequest) {
    return (
      <ThemeProvider settings={settings}>
        <McpTrustPrompt request={trustRequest} />
      </ThemeProvider>
    )
  }
  return controller ? (
    <ChatApp controller={controller} />
  ) : (
    <ThemeProvider settings={settings}>
      <StartingHarness animate={settings.animations} />
    </ThemeProvider>
  )
}
