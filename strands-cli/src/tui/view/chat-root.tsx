import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ThemeProvider } from './theme.js'

import { ChatApp } from './app.js'
import type { ChatControllerApi } from '../chat/controller.js'
import { DEFAULT_CHAT_SETTINGS } from '../chat/types.js'
import type { CliConfigStore } from '../config.js'
import type { RequestSetup, SetupChange } from '../agent-configuration.js'
import { McpTrustPrompt, type McpTrustRequest } from './mcp-trust-prompt.js'
import { SetupWizard } from './setup-wizard/index.js'

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
}

export function ChatRoot({
  controller,
  intro,
  setup,
  config,
  trustRequest,
  setupBridge,
  onSetupComplete,
}: ChatRootProps): ReactElement | null {
  const [phase, setPhase] = useState<'setup' | 'chat' | 'cancelled'>(setup ? 'setup' : 'chat')
  const introStartedAt = useRef<number | undefined>(undefined)
  if (controller && intro && !setup && introStartedAt.current === undefined) {
    introStartedAt.current = Date.now()
  }
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
    return (
      <SetupWizard
        config={config}
        deferred
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
  return controller ? (
    <ChatApp
      controller={controller}
      {...(introStartedAt.current !== undefined ? { introStartedAt: introStartedAt.current } : {})}
    />
  ) : null
}
