import type { HarnessAgentOptions } from '@strands-agents/harness'
import { DEFAULT_MEMORY_DIR } from '@strands-agents/harness/internal'
import { MemoryManager } from '@strands-agents/sdk'

/** The directory the harness's default memory store writes to; a `MemoryManager` instance has no known directory. */
export function memoryDirectory(memory: HarnessAgentOptions['memory']): string {
  if (memory instanceof MemoryManager || typeof memory !== 'object' || memory === null) {
    return DEFAULT_MEMORY_DIR
  }
  return memory.dir ?? DEFAULT_MEMORY_DIR
}
