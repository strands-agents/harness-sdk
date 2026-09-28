import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { requireBedrockRegion } from '../src/tui/provider/aws-config.js'

const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Bedrock token region validation', () => {
  it('requires a token region and accepts environment, profile, and symlinked profile regions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'strands-region-'))
    directories.push(directory)
    const config = join(directory, 'config')
    vi.stubEnv('AWS_CONFIG_FILE', config)
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(directory, 'credentials'))
    vi.stubEnv('AWS_PROFILE', 'review')
    vi.stubEnv('AWS_REGION', '')
    vi.stubEnv('AWS_DEFAULT_REGION', '')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'test-token')
    expect(() => requireBedrockRegion('bedrock/test')).toThrow('region that issued AWS_BEARER_TOKEN_BEDROCK')
    expect(() => requireBedrockRegion('bedrock-mantle/test')).toThrow('region that issued AWS_BEARER_TOKEN_BEDROCK')
    expect(() => requireBedrockRegion('openai/test')).not.toThrow()
    expect(() => requireBedrockRegion({})).not.toThrow()
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-2')
    expect(() => requireBedrockRegion('bedrock/test')).not.toThrow()
    vi.stubEnv('AWS_DEFAULT_REGION', '')
    writeFileSync(config, '[profile review]\nregion = eu-west-1\n')
    expect(() => requireBedrockRegion('bedrock/test')).not.toThrow()
    const link = join(directory, 'config-link')
    symlinkSync(config, link)
    vi.stubEnv('AWS_CONFIG_FILE', link)
    expect(() => requireBedrockRegion('bedrock/test')).not.toThrow()
    vi.stubEnv('AWS_PROFILE', 'unknown')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '')
    expect(() => requireBedrockRegion('bedrock/test')).not.toThrow()
  })
})
