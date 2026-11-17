/**
 * `vi.mock` factories for the cache strategy suites. Kept free of SDK imports so a hoisted factory can load it.
 */
import { vi } from 'vitest'

/** Factory for `vi.mock('@aws-sdk/client-bedrock-runtime', ...)`. */
export async function mockBedrockRuntime(
  importOriginal: () => Promise<typeof import('@aws-sdk/client-bedrock-runtime')>
): Promise<object> {
  const original = await importOriginal()
  const send = vi.fn(async () => ({
    stream: (async function* (): AsyncGenerator<unknown> {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockDelta: { delta: { text: 'ok' } } }
      yield { contentBlockStop: {} }
      yield { messageStop: { stopReason: 'end_turn' } }
    })(),
  }))
  return {
    ...original,
    BedrockRuntimeClient: vi.fn(function () {
      return {
        send,
        middlewareStack: { add: vi.fn() },
        config: { region: vi.fn(async () => 'us-east-1'), useFipsEndpoint: vi.fn(async () => false) },
      }
    }),
    ConverseStreamCommand: vi.fn(),
  }
}

/** Factory for `vi.mock('../../logging/warn-once.js', ...)`, so every row sees its own warnings. */
export function warnOnceWithoutDedupe(): object {
  return { warnOnce: (target: { warn(msg: string): void }, msg: string) => target.warn(msg) }
}
