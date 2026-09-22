import { createRequire } from 'node:module'

import type { ProviderId } from '../config.js'

// The provider SDKs are optional peers of @strands-agents/sdk, imported only when a model for
// that provider is constructed. strands-cli doesn't hard-depend on them, so a provider is usable
// only if its package is installed next to the CLI.
export const PROVIDER_PACKAGES: Readonly<Partial<Record<ProviderId, string>>> = {
  anthropic: '@anthropic-ai/sdk',
  openai: 'openai',
  'bedrock-mantle': 'openai',
  ollama: 'openai',
  litellm: 'openai',
  google: '@google/genai',
}

const resolvable = new Map<string, boolean>()

export function missingProviderPackage(provider: ProviderId): string | undefined {
  const name = PROVIDER_PACKAGES[provider]
  if (!name) {
    return undefined
  }
  let installed = resolvable.get(name)
  if (installed === undefined) {
    try {
      createRequire(import.meta.url).resolve(name)
      installed = true
    } catch {
      installed = false
    }
    resolvable.set(name, installed)
  }
  return installed ? undefined : name
}

const PACKAGE_NAMES = new Set(Object.values(PROVIDER_PACKAGES))

export function rethrowWithProviderHint(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  const name = /Cannot find (?:module|package) '([^']+)'/u.exec(message)?.[1]
  if (name && PACKAGE_NAMES.has(name)) {
    throw new Error(
      `This model's provider needs the ${name} package, which is not installed. ` +
        `Install it alongside strands-cli (npm install -g ${name}) and retry.`,
      { cause: error }
    )
  }
  throw error
}
