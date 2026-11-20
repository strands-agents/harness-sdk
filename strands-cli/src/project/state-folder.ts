import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IGNORE_ALL = '*\n'

export const ignoreStateFolder = (state: string): boolean => {
  try {
    writeFileSync(join(state, '.gitignore'), IGNORE_ALL, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
