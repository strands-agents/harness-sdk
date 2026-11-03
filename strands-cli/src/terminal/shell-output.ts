import { Buffer } from 'node:buffer'

export const SHELL_OUTPUT_LIMIT_BYTES = 256 * 1024
export const SHELL_OUTPUT_PREVIEW_BYTES = 2 * 1024
export const SHELL_OUTPUT_PREVIEW_LABEL = '2 KiB'
export const SHELL_OUTPUT_HARD_LIMIT_BYTES = 16 * 1024 * 1024
export const SHELL_OUTPUT_HARD_LIMIT_LABEL = '16 MiB'
export const SHELL_OUTPUT_LIMIT_NOTICE =
  '\n[Output too large; remaining live output omitted while the command continues.]\n'

export function limitShellOutputChunk(
  chunk: string,
  retainedBytes: number,
  limitBytes = SHELL_OUTPUT_LIMIT_BYTES
): { text: string; bytes: number; truncated: boolean } {
  const remainingBytes = Math.max(0, limitBytes - retainedBytes)
  const chunkBytes = Buffer.byteLength(chunk)
  if (chunkBytes <= remainingBytes) {
    return { text: chunk, bytes: chunkBytes, truncated: false }
  }

  let bytes = 0
  let end = 0
  for (const character of chunk) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > remainingBytes) {
      break
    }
    bytes += characterBytes
    end += character.length
  }
  return { text: chunk.slice(0, end), bytes, truncated: true }
}

export function shellOutputSummary(outputBytes: number, path: string, preview: string): string {
  return (
    `Output too large (${formatShellOutputSize(outputBytes)}). Full output saved to: ${path}\n\n` +
    `Preview (first ${SHELL_OUTPUT_PREVIEW_LABEL}):\n${preview}`
  )
}

export function shellOutputHardLimitSummary(path: string, preview: string): string {
  return (
    `Output exceeded the ${SHELL_OUTPUT_HARD_LIMIT_LABEL} emergency limit and the command was stopped. ` +
    `Partial output saved to: ${path}\n\nPreview (first ${SHELL_OUTPUT_PREVIEW_LABEL}):\n${preview}`
  )
}

function formatShellOutputSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${bytes} B`
}
