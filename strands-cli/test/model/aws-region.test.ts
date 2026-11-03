import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { discoverAwsConfiguration, requireBedrockRegion } from '../../src/model/aws-config.js'

import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Bedrock token region validation', () => {
  it('discovers AWS profiles without offering SSO sessions or service sections as profiles', async () => {
    const directory = await temporaryDirectory('strands-region-')
    const config = join(directory, 'config')
    const credentials = join(directory, 'credentials')
    writeFileSync(credentials, '[default]\nregion = us-east-1\n[legacy name]\nregion = eu-west-1\n')
    writeFileSync(
      config,
      '[default]\nregion = us-west-2\n[profile work name]\nsso_session = corp\nregion = ap-northeast-1\n' +
        '[sso-session corp]\nsso_region = us-east-1\n[services local]\ns3 =\n  endpoint_url = http://localhost:4567\n'
    )

    expect(discoverAwsConfiguration({ AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials })).toEqual({
      profiles: ['default', 'legacy name', 'work name'],
      regions: ['ap-northeast-1', 'eu-west-1', 'us-east-1', 'us-west-2'],
      profileRegions: { default: 'us-west-2', 'legacy name': 'eu-west-1', 'work name': 'ap-northeast-1' },
    })
  })

  it.each(['review', 'constructor'])('requires a token region and accepts the %s profile region', async (profile) => {
    const directory = await temporaryDirectory('strands-region-')
    const config = join(directory, 'config')
    vi.stubEnv('AWS_CONFIG_FILE', config)
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(directory, 'credentials'))
    vi.stubEnv('AWS_PROFILE', profile)
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
    writeFileSync(config, `[profile ${profile}]\nregion = eu-west-1\n`)
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
