import { createRequire } from 'node:module'

import type { ProviderId } from '../config.js'

// @strands-agents/sdk imports provider SDKs only when their models are constructed. The CLI ships
// all of them so every provider offered during setup works after the initial CLI installation.
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
      `This CLI installation is missing the required ${name} package. ` + 'Reinstall @strands-agents/cli and retry.',
      { cause: error }
    )
  }
  throw error
}
