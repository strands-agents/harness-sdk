import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

const CONFIG_WATCH_DEBOUNCE_MS = 200

export const watchConfigFile = (path: string, onChange: () => void): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename?.toString() !== basename(path)) return
      clearTimeout(timer)
      timer = setTimeout(onChange, CONFIG_WATCH_DEBOUNCE_MS)
    })
  } catch {
    return () => {}
  }
  watcher.on('error', () => watcher.close())
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
