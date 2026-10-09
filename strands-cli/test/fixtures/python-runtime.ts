import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const pythonExecutable =
  process.env.STRANDS_TEST_PYTHON ??
  join(
    fileURLToPath(new URL('../../../harness-py/.venv', import.meta.url)),
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  )
export const pythonEnvironment = dirname(dirname(pythonExecutable))
