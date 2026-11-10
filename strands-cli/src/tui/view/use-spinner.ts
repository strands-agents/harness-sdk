import { useEffect, useState } from 'react'

const SPINNER_FRAMES = ['|', '/', '-', '\\'] as const

export function useSpinner(active: boolean, animate: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active || !animate) {
      return
    }
    const timer = setInterval(() => setFrame((value) => value + 1), 100)
    return (): void => clearInterval(timer)
  }, [active, animate])
  return animate ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]! : '*'
}
