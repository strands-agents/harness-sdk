import type { HarnessAgentOptions } from '@strands-agents/harness'
import { join } from 'node:path'

export const isolateDevState = (options: HarnessAgentOptions, root: string): HarnessAgentOptions => {
  if (
    options.sessionManager ||
    options.memoryManager ||
    options.storage ||
    (typeof options.session === 'object' && options.session && 'initialize' in options.session) ||
    (typeof options.memory === 'object' && options.memory && 'getTools' in options.memory)
  ) {
    throw new Error(
      'Dev cannot isolate custom session, memory, or storage managers. Use file-based session and memory options for this workspace.'
    )
  }
  const { session, memory } = options
  if (typeof memory === 'object' && memory?.stores?.length) {
    throw new Error('Dev cannot isolate custom memory stores. Use the workspace file-based memory configuration.')
  }
  return {
    ...options,
    session:
      session === false
        ? false
        : { ...(typeof session === 'object' ? session : {}), dir: join(root, '.strands/state/sessions') },
    memory:
      memory === false
        ? false
        : { ...(typeof memory === 'object' ? memory : {}), dir: join(root, '.strands/state/memory') },
  }
}
