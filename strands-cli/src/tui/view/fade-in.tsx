import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useStdout } from 'ink'

const FadeContext = createContext<{ background: string; progress: number } | undefined>(undefined)
const FADE_DURATION_MS = 400

export function Fade({
  background,
  progress,
  children,
}: {
  background: string
  progress: number
  children: ReactNode
}): ReactElement {
  const parent = useContext(FadeContext)
  const visible = Math.max(0, Math.min(1, progress))
  const fade =
    visible < 1
      ? {
          background: parent?.background ?? background,
          progress: visible * (parent?.progress ?? 1),
        }
      : parent
  return <FadeContext value={fade}>{children}</FadeContext>
}

export function FadeIn({
  animate,
  background,
  children,
}: {
  animate: boolean
  background: string
  children: ReactNode
}): ReactElement {
  const { stdout } = useStdout()
  const enabled = animate && stdout.isTTY
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const startedAt = Date.now()
    setProgress(0)
    const timer = setInterval(() => {
      const next = Math.min(1, (Date.now() - startedAt) / FADE_DURATION_MS)
      setProgress(next)
      if (next === 1) {
        clearInterval(timer)
      }
    }, 32)
    return (): void => clearInterval(timer)
  }, [enabled])

  return (
    <Fade background={background} progress={enabled ? 1 - (1 - progress) ** 3 : 1}>
      {children}
    </Fade>
  )
}

export function useFadeTransition(animate: boolean): {
  progress: number
  transitioning: boolean
  transition(change: () => void): void
} {
  const { stdout } = useStdout()
  const enabled = animate && stdout.isTTY
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const transitioningRef = useRef(false)
  const [progress, setProgress] = useState(1)
  const [transitioning, setTransitioning] = useState(false)

  useEffect(
    () => (): void => {
      if (timer.current) {
        clearInterval(timer.current)
      }
    },
    []
  )

  const transition = useCallback(
    (change: () => void): void => {
      if (!enabled) {
        change()
        return
      }
      if (transitioningRef.current) {
        return
      }

      transitioningRef.current = true
      setTransitioning(true)
      const run = (from: number, to: number, duration: number, complete: () => void): void => {
        const startedAt = Date.now()
        setProgress(from)
        timer.current = setInterval(() => {
          const elapsed = Math.min(1, (Date.now() - startedAt) / duration)
          const eased = elapsed * elapsed * (3 - 2 * elapsed)
          setProgress(from + (to - from) * eased)
          if (elapsed === 1) {
            clearInterval(timer.current)
            timer.current = undefined
            complete()
          }
        }, 32)
      }

      run(1, 0, 160, () => {
        change()
        run(0, 1, FADE_DURATION_MS - 160, () => {
          setProgress(1)
          transitioningRef.current = false
          setTransitioning(false)
        })
      })
    },
    [enabled]
  )

  return { progress, transitioning, transition }
}

export function useFadeColor(color: string | undefined): string | undefined {
  const fade = useContext(FadeContext)
  if (!fade || !color?.startsWith('#')) {
    return color
  }
  return mixHexColors(fade.background, color, fade.progress)
}

export function mixHexColors(from: string, to: string, progress: number): string {
  if (!/^#[0-9a-f]{6}$/iu.test(from) || !/^#[0-9a-f]{6}$/iu.test(to)) {
    return to
  }
  const amount = Math.max(0, Math.min(1, progress))
  const channels = [1, 3, 5].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16)
    const end = Number.parseInt(to.slice(offset, offset + 2), 16)
    return Math.round(start + (end - start) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`
}
