import { useMemo, useSyncExternalStore } from 'react'
import { useStdout } from 'ink'

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const store = useMemo(() => {
    let size = { columns: stdout.columns || 80, rows: stdout.rows || 24 }
    return {
      getSnapshot: (): typeof size => {
        const columns = stdout.columns || 80
        const rows = stdout.rows || 24
        if (size.columns !== columns || size.rows !== rows) size = { columns, rows }
        return size
      },
      subscribe: (listener: () => void): (() => void) => {
        stdout.on('resize', listener)
        return (): void => {
          stdout.off('resize', listener)
        }
      },
    }
  }, [stdout])
  // External-store updates commit synchronously before Ink paints the resized viewport.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
