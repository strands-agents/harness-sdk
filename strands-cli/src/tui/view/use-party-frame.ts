import { useEffect, useState } from 'react'

export const PARTY_FRAME_INTERVAL_MS = 80

export function usePartyFrame(active: boolean): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % 1_000_000), PARTY_FRAME_INTERVAL_MS)
    return (): void => clearInterval(timer)
  }, [active])

  return frame
}
