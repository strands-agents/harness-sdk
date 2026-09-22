import { describe, expect, it, vi } from 'vitest'

import type { DetectedProviderEnvironment } from '../src/tui/config.js'
import {
  compatibleProfile,
  effectiveProviderEnvironment,
  exaWebSearchActive,
  providerAssessment,
  quickstartDraft,
} from '../src/tui/view/setup-wizard/providers.js'
import { webSearchFallback, withWebSearchFallback } from '../src/tui/builtin-tools.js'
import { rowsForStep } from '../src/tui/view/setup-wizard/steps.js'

describe('setup provider credentials', () => {
  const aws = {
    profiles: ['default', 'review'],
    regions: ['us-west-2', 'eu-west-1'],
    profileRegions: { default: 'us-west-2', review: 'eu-west-1' },
  }

  it.each([
    ['valid', 'success'],
    ['expired', 'error'],
    ['missing', 'error'],
    ['unavailable', 'error'],
  ] as const)('distinguishes %s AWS credentials in provider status', (credentialStatus, status) => {
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('bedrock', {}),
      '',
      {},
      {},
      'bedrock',
      credentialStatus === 'valid' ? ['bedrock', 'bedrock-mantle'] : [],
      { ...aws, credentialStatus },
      undefined,
      () => {},
      () => {},
      () => {}
    )
    expect(rows.find((row) => row.id === 'bedrock')?.status).toBe(status)
    expect(rows.find((row) => row.id === 'bedrock-mantle')?.status).toBe(status)
  })

  it('follows the selected profile and refreshed AWS config without retaining an inferred region', () => {
    const detected = { AWS_REGION: { value: 'us-west-2', source: 'aws-profile' as const } }
    expect(effectiveProviderEnvironment({ AWS_PROFILE: 'review' }, detected, aws).AWS_REGION?.value).toBe('eu-west-1')
    expect(
      effectiveProviderEnvironment({ AWS_PROFILE: 'review' }, detected, {
        ...aws,
        profileRegions: { review: 'ap-northeast-1' },
      }).AWS_REGION?.value
    ).toBe('ap-northeast-1')
    expect(effectiveProviderEnvironment({ AWS_PROFILE: 'unknown' }, detected, aws).AWS_REGION).toBeUndefined()
  })

  it.each(['AWS_REGION', 'AWS_DEFAULT_REGION'] as const)('preserves explicit %s over profile inference', (key) => {
    const environment = effectiveProviderEnvironment(
      { AWS_PROFILE: 'review', [key]: 'us-east-2' },
      { AWS_REGION: { value: 'us-west-2', source: 'aws-profile' } },
      aws
    )
    expect(environment[key]?.value).toBe('us-east-2')
    if (key === 'AWS_DEFAULT_REGION') expect(environment.AWS_REGION).toBeUndefined()
  })

  it('keeps shell profile and region values ahead of setup overrides', () => {
    const environment = effectiveProviderEnvironment(
      { AWS_PROFILE: 'review', AWS_REGION: 'eu-west-1' },
      {
        AWS_PROFILE: { value: 'default', source: 'process' },
        AWS_REGION: { value: 'us-east-2', source: 'process' },
      },
      aws
    )
    expect(environment.AWS_PROFILE?.value).toBe('default')
    expect(environment.AWS_REGION?.value).toBe('us-east-2')
  })

  it('offers an editable session-only field when an API key was not detected', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const setEditing = vi.fn()
    const detectedEnvironment: DetectedProviderEnvironment = {}
    const apiKey = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('openai', {}),
      '',
      {},
      detectedEnvironment,
      'openai',
      [],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      setEditing
    ).find((row) => row.id === 'openai:OPENAI_API_KEY')

    expect(apiKey?.description).toBe('Session only · Add to ~/.zshrc for future sessions')
    expect(apiKey?.input).toBe(true)
    apiKey?.activate()
    expect(setEditing).toHaveBeenCalledWith({ field: 'OPENAI_API_KEY', value: '' })
    vi.unstubAllEnvs()
  })

  it('detects Ollama without asking for an endpoint', () => {
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('ollama', {}),
      '',
      {},
      {},
      'ollama',
      [],
      { profiles: [], regions: [] },
      { installed: true, running: false, models: [] },
      () => {},
      () => {},
      () => {}
    )

    expect(rows.some((row) => row.field === 'OLLAMA_HOST')).toBe(false)
  })

  it('asks for a LiteLLM key only when the proxy requests authentication', () => {
    const environment = { LITELLM_API_KEY: { value: 'rejected', source: 'process' as const } }
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('litellm', environment),
      '',
      {},
      environment,
      'litellm',
      [],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      () => {},
      { reachable: true, authenticationRequired: true, models: [], status: 401 }
    )

    expect(rows.find((row) => row.id === 'litellm:LITELLM_API_KEY')).toMatchObject({
      input: true,
      description: 'Rejected · environment',
    })
    expect(rows.some((row) => row.field === 'LITELLM_BASE_URL')).toBe(false)
  })

  it('hides credential fields after detecting an API key', () => {
    const environment = { OPENAI_API_KEY: { value: 'secret', source: 'process' as const } }
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('openai', environment),
      '',
      {},
      environment,
      'openai',
      ['openai'],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      () => {}
    )

    expect(rows.find((row) => row.id === 'openai:OPENAI_API_KEY')).toBeUndefined()
  })

  it('offers a replacement field after an API key is rejected', () => {
    const setEditing = vi.fn()
    const environment = { OPENAI_API_KEY: { value: 'rejected', source: 'session' as const } }
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('openai', environment),
      '',
      {},
      environment,
      'openai',
      [],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      setEditing,
      undefined,
      'openai'
    )

    expect(rows.find((row) => row.id === 'openai')).toMatchObject({
      description: 'Setup required',
      status: 'error',
    })
    const apiKey = rows.find((row) => row.id === 'openai:OPENAI_API_KEY')
    expect(apiKey).toMatchObject({ input: true, description: 'Rejected · this session' })
    apiKey?.activate()
    expect(setEditing).toHaveBeenCalledWith({ field: 'OPENAI_API_KEY', value: '' })
  })

  it('keeps the credential panel stable while validating an API key', () => {
    const environment = { GEMINI_API_KEY: { value: 'checking', source: 'session' as const } }
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('google', environment),
      '',
      {},
      environment,
      'google',
      [],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      'google'
    )

    expect(rows.find((row) => row.id === 'google')).toMatchObject({
      description: 'Validating',
      status: 'warning',
    })
    expect(rows.find((row) => row.id === 'google:GEMINI_API_KEY')).toMatchObject({
      input: false,
      description: 'Checking API key...',
    })
  })

  it('keeps missing-credential guidance concise and points to the shell profile', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const warning = providerAssessment('openai', {}, { profiles: [], regions: [] }, undefined).warning

    expect(warning).toBe('OPENAI_API_KEY was not detected.')
    vi.unstubAllEnvs()
  })

  it('keeps local-provider guidance concise', () => {
    expect(
      providerAssessment('ollama', {}, { profiles: [], regions: [] }, { installed: true, running: true, models: [] })
        .warning
    ).toBe('Run ollama pull {model id}, then choose Refresh.')
    expect(
      providerAssessment('litellm', {}, { profiles: [], regions: [] }, undefined, {
        reachable: false,
        authenticationRequired: false,
        models: [],
      }).warning
    ).toBe('Start the LiteLLM proxy on localhost:4000, then choose Refresh.')
    expect(
      providerAssessment('litellm', {}, { profiles: [], regions: [] }, undefined, {
        reachable: true,
        authenticationRequired: true,
        models: [],
        status: 401,
      }).warning
    ).toBe('Enter LITELLM_API_KEY below, then choose Refresh.')
    expect(
      providerAssessment('litellm', {}, { profiles: [], regions: [] }, undefined, {
        reachable: true,
        authenticationRequired: false,
        models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
        status: 200,
      }).warning
    ).toBeUndefined()
  })

  it('keeps ready-provider model controls while hiding credentials', () => {
    const environment = { OPENAI_API_KEY: { value: 'secret', source: 'process' as const } }
    const draft = quickstartDraft('openai', environment)
    draft.providers = ['bedrock', 'openai']
    const rows = rowsForStep(
      1,
      'manual',
      draft,
      '',
      {},
      environment,
      'openai',
      ['openai'],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      () => {}
    )

    expect(rows.find((row) => row.id === 'openai:OPENAI_API_KEY')).toBeUndefined()
    expect(rows.map((row) => row.id)).toContain('thinking')
    expect(rows.map((row) => row.id)).not.toEqual(expect.arrayContaining(['openai:default', 'custom-model']))
  })

  it.each([
    ['openai/gpt-5.6-sol', ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high']],
    ['bedrock/qwen.qwen3-next-80b-a3b', ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max']],
  ])('uses the supported effort range for %s', (model, labels) => {
    const provider = model.startsWith('openai/') ? 'openai' : 'bedrock'
    const draft = quickstartDraft(provider, {})
    draft.profile = { ...draft.profile, model }
    const rows = rowsForStep(
      1,
      'quickstart',
      draft,
      '',
      {},
      {},
      provider,
      [provider],
      { ...aws, credentialStatus: 'valid' },
      undefined,
      () => {},
      () => {},
      () => {}
    )

    expect(rows.find((row) => row.id === 'thinking')?.choices?.map((choice) => choice.label)).toEqual(labels)
  })

  it('omits reasoning controls when the selected model does not support effort', () => {
    const draft = quickstartDraft('ollama', { OLLAMA_MODEL: { value: 'llama3.2', source: 'process' } })
    const rows = rowsForStep(
      1,
      'quickstart',
      draft,
      '',
      {},
      {},
      'ollama',
      ['ollama'],
      aws,
      { installed: true, running: true, models: ['llama3.2'] },
      () => {},
      () => {},
      () => {}
    )

    expect(rows.find((row) => row.id === 'thinking')).toBeUndefined()
  })
})

describe('setup web_search availability', () => {
  it('keeps web_search in a bedrock-mantle GPT-5 profile', () => {
    expect(quickstartDraft('bedrock-mantle', {}).profile.builtinTools).toContain('web_search')
  })

  it('drops the plain web_search default without native search but keeps the Exa opt-in', () => {
    const bedrock = quickstartDraft('bedrock', {}).profile
    expect(bedrock.builtinTools).not.toContain('web_search')
    const exa = { ...bedrock, builtinTools: { web_search: 'exa' as const } }
    expect(compatibleProfile(exa)).toBe(exa)
  })

  it('shows the Exa row as a yellow third-party warning, unchecked, on a model without native search', () => {
    const noop = (): void => {}
    const toolsRow = (draft: ReturnType<typeof quickstartDraft>): ReturnType<typeof rowsForStep>[number] | undefined =>
      rowsForStep(
        2,
        'quickstart',
        draft,
        '',
        {},
        {},
        'bedrock',
        [],
        { profiles: [], regions: [] },
        undefined,
        noop,
        noop,
        noop
      ).find((row) => row.id === 'web_search')
    const bedrock = toolsRow(quickstartDraft('bedrock', {}))
    expect(bedrock?.active).toBe(false)
    expect(bedrock?.description).toMatch(/^⚠ .*Exa/)
    expect(bedrock?.descriptionColor).toBe('yellow')
    const mantle = toolsRow(quickstartDraft('bedrock-mantle', {}))
    expect(mantle?.active).toBe(true)
    expect(mantle?.descriptionColor).toBeUndefined()
  })

  it('reports Exa as active only when opted in on a model without native search', () => {
    const bedrock = quickstartDraft('bedrock', {}).profile
    expect(exaWebSearchActive(bedrock)).toBe(false)
    expect(exaWebSearchActive({ ...bedrock, builtinTools: { web_search: 'exa' } })).toBe(true)
    const mantle = quickstartDraft('bedrock-mantle', {}).profile
    expect(exaWebSearchActive({ ...mantle, builtinTools: { web_search: 'exa' } })).toBe(false)
  })

  it('opts a profile into Exa by storing the string, whichever form builtinTools uses', () => {
    expect(withWebSearchFallback(['read', 'shell'])).toMatchObject({ read: true, shell: true, web_search: 'exa' })
    expect(withWebSearchFallback({ subagent: false })).toEqual({ subagent: false, web_search: 'exa' })
    expect(webSearchFallback(withWebSearchFallback({}))).toBe('exa')
  })
})
