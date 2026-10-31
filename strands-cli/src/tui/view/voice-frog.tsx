import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Box } from 'ink'

import type { ChatSnapshot, ChatVoiceStore } from '../chat/controller.js'
import { renderVoiceFrogRuns } from './frog-intro-renderer.js'
import { Text, useTheme } from './theme.js'

export const VOICE_FROG_HEIGHT = 8
export const VOICE_FROG_WIDTH = 18
const VOICE_FROG_ENTRY_MS = 720
const VOICE_FROG_FRAME_MS = 80

export function VoiceFrog({
  snapshot: fallbackSnapshot,
  voice,
  width,
  top,
  animate,
  theme,
}: {
  snapshot: NonNullable<ChatSnapshot['voice']>
  voice?: ChatVoiceStore
  width: number
  top: number
  animate: boolean
  theme: ChatSnapshot['settings']['frogTheme']
}): ReactElement | null {
  const colors = useTheme()
  const getSnapshot = voice?.getSnapshot ?? ((): NonNullable<ChatSnapshot['voice']> => fallbackSnapshot)
  const snapshot = useSyncExternalStore(voice?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot)
  const speaking = snapshot.status === 'speaking'
  const [elapsedMs, setElapsedMs] = useState(animate ? 0 : VOICE_FROG_ENTRY_MS)
  const entryComplete = elapsedMs >= VOICE_FROG_ENTRY_MS

  useEffect(() => {
    if (!animate || (entryComplete && !speaking)) {
      return
    }
    const timer = setInterval(() => setElapsedMs((elapsed) => elapsed + VOICE_FROG_FRAME_MS), VOICE_FROG_FRAME_MS)
    return (): void => clearInterval(timer)
  }, [animate, entryComplete, speaking])

  if (snapshot.status === 'off' || snapshot.status === 'error') {
    return null
  }

  const entryProgress = animate ? Math.min(1, elapsedMs / VOICE_FROG_ENTRY_MS) : 1
  const runs = renderVoiceFrogRuns(
    VOICE_FROG_WIDTH,
    VOICE_FROG_HEIGHT,
    entryProgress,
    elapsedMs,
    speaking,
    true,
    theme,
    { colorMode: colors.mode }
  )
  return (
    <Box
      position="absolute"
      marginTop={top}
      marginLeft={Math.max(0, width - VOICE_FROG_WIDTH)}
      width={Math.min(width, VOICE_FROG_WIDTH)}
      height={VOICE_FROG_HEIGHT}
      overflow="hidden"
      aria-hidden
    >
      {runs.map((run) => (
        <Box key={`${run.row}:${run.column}`} position="absolute" marginTop={run.row} marginLeft={run.column}>
          <Text>{run.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function emptySubscribe(): () => void {
  return () => {}
}
