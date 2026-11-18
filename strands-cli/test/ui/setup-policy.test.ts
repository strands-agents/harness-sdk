import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  defineHarnessAgentConfig,
  harnessAgentOptionsFromConfig,
  type HarnessAgentConfig,
  type HarnessConfigBuiltinTools,
} from '@strands-agents/harness'

import type { DetectedProviderEnvironment } from '../../src/config/store.js'
import {
  compatibleProfile,
  effectiveProviderEnvironment,
  exaWebSearchActive,
  providerAssessment,
  quickstartDraft,
} from '../../src/ui/setup/providers.js'
import {
  builtinToolChoices,
  enabledProfileTools,
  profileToolEnabled,
  webSearchFallback,
  withWebSearchFallback,
} from '../../src/agent/tools.js'
import { rowsForStep } from '../../src/ui/setup/steps.js'
import { resolveSkillSources } from '../../src/agent/skills.js'

function setupControls(profile: Partial<HarnessAgentConfig>, discovery = true) {
  let draft = quickstartDraft()
  draft.profile = defineHarnessAgentConfig(profile)
  draft.settings.skillDiscovery = discovery
  return {
    get draft() {
      return draft
    },
    row(step: number, id: string) {
      return rowsForStep(
        step,
        'customize',
        draft,
        '',
        {},
        {},
        'bedrock',
        [],
        { profiles: [], regions: [] },
        undefined,
        (update) => {
          draft = update(draft)
        },
        (update) => {
          draft = { ...draft, profile: { ...draft.profile, ...update } }
        },
        () => {}
      ).find((row) => row.id === id)!
    },
  }
}

const configuredTools: HarnessConfigBuiltinTools = {
  shell: { description: 'Custom shell' },
  read: { media: false },
  web_fetch: { model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0' },
  programmatic_tool_caller: { timeout: 60, allowedTools: ['read'] },
  subagent: { maxDepth: 0 },
}

describe('setup feature controls', () => {
  it.each([false, true])('preserves configured sources and discovery=%s across both pages', (discovery) => {
    const skills = ['./team-skills', 'https://example.com/SKILL.md']
    const controls = setupControls({ skills }, discovery)
    for (const step of [4, 5]) {
      expect(controls.row(step, 'skills').active).toBe(true)
      controls.row(step, 'skills').activate()
      expect(controls.draft.profile.skills).toBe(false)
      expect(controls.draft.settings.skillDiscovery).toBe(discovery)
      controls.row(step, 'skills').activate()
      expect(controls.draft.profile.skills).toEqual(skills)
      expect(controls.draft.settings.skillDiscovery).toBe(discovery)
    }
  })

  it.each([
    { skills: false, discovery: false },
    { skills: false, discovery: true },
    { skills: [], discovery: false },
    { skills: [], discovery: true },
  ] as const)('reflects disabled skills and enables sources: %j', ({ skills, discovery }) => {
    for (const step of [4, 5]) {
      const controls = setupControls({ skills }, discovery)
      const sources = () => {
        const value = controls.draft.profile.skills
        return resolveSkillSources(
          typeof value === 'object' ? [...value] : value,
          process.cwd(),
          controls.draft.settings.skillDiscovery
        )
      }
      expect(sources()).toEqual([])
      expect(controls.row(step, 'skills').active).toBe(false)
      controls.row(step, 'skills').activate()
      expect(controls.row(step, 'skills').active).toBe(true)
      expect(sources().length).toBeGreaterThan(0)
      controls.row(step, 'skills').activate()
      expect(controls.row(step, 'skills').active).toBe(false)
      expect(sources()).toEqual([])
    }
  })

  it.each([true, { dir: './private-memory' }])('preserves memory %j across both pages', (memory) => {
    const controls = setupControls({ memory })
    for (const step of [4, 5]) {
      controls.row(step, 'memory').activate()
      expect(controls.draft.profile.memory).toBe(false)
      controls.row(step, 'memory').activate()
      expect(controls.draft.profile.memory).toEqual(memory)
    }
  })

  it('preserves context strategy and background task limits', async () => {
    const controls = setupControls({
      contextManager: 'agentic',
      agentConfig: { backgroundTasks: { maxConcurrency: 2, timeout: 23000 } },
    })
    const before = controls.draft.profile
    await harnessAgentOptionsFromConfig(before)
    for (const id of ['context', 'background-tasks']) {
      controls.row(4, id).activate()
      expect(controls.row(4, id).active).toBe(false)
      controls.row(4, id).activate()
      expect(defineHarnessAgentConfig(controls.draft.profile)).toEqual(before)
    }
    controls
      .row(5, 'context')
      .choices!.find((choice) => choice.label === 'Automatic')!
      .activate()
    controls
      .row(5, 'context')
      .choices!.find((choice) => choice.label === 'Off')!
      .activate()
    controls.row(4, 'context').activate()
    expect(controls.draft.profile.contextManager).toBe('auto')
  })

  it.each(Object.keys(configuredTools))('preserves the %s tool configuration', async (id) => {
    const controls = setupControls({ builtinTools: configuredTools })
    const before = controls.draft.profile
    await harnessAgentOptionsFromConfig(before)
    const disable = controls.row(3, id).activate
    disable()
    disable()
    expect(controls.row(3, id).active).toBe(false)
    controls.row(3, id).activate()
    expect(defineHarnessAgentConfig(controls.draft.profile)).toEqual(before)
  })

  it.each([false, true])('preserves all feature options and discovery=%s through bulk toggles', async (discovery) => {
    const profile = defineHarnessAgentConfig({
      skills: ['./team-skills'],
      memory: { dir: './private-memory' },
      contextManager: 'agentic',
      agentConfig: { backgroundTasks: { maxConcurrency: 2, timeout: 23000 }, maxParallelTools: 3 },
    })
    const controls = setupControls(profile, discovery)
    await harnessAgentOptionsFromConfig(profile)
    expect(controls.row(4, 'select-all').label).toBe('Deselect all')
    controls.row(4, 'select-all').activate()
    expect(controls.draft.profile).toMatchObject({
      skills: false,
      memory: false,
      contextManager: false,
      agentConfig: { backgroundTasks: false },
    })
    expect(controls.draft.settings.skillDiscovery).toBe(discovery)
    controls.row(4, 'select-all').activate()
    expect(defineHarnessAgentConfig(controls.draft.profile)).toEqual(profile)
    expect(controls.draft.settings.skillDiscovery).toBe(discovery)
    controls.row(4, 'memory').activate()
    controls.row(4, 'select-all').activate()
    expect(defineHarnessAgentConfig(controls.draft.profile)).toEqual(profile)
  })

  it.each([false, true])('preserves configured tools and explicit Exa=%s through bulk toggles', async (exa) => {
    const tools = { ...configuredTools, web_search: exa ? ('exa' as const) : false }
    const controls = setupControls({ builtinTools: tools })
    await harnessAgentOptionsFromConfig(controls.draft.profile)
    expect(controls.row(3, 'select-all').label).toBe('Deselect all')
    controls.row(3, 'select-all').activate()
    expect(enabledProfileTools(controls.draft.profile.builtinTools)).toEqual([])
    controls.row(3, 'select-all').activate()
    expect(controls.draft.profile.builtinTools).toMatchObject(tools)
    expect(controls.row(3, 'select-all').label).toBe('Deselect all')
  })

  it('enables defaults without adding Exa or converting a tool list to a mapping', () => {
    const controls = setupControls({
      skills: [],
      memory: false,
      contextManager: false,
      agentConfig: { backgroundTasks: false },
      builtinTools: ['read'],
    })
    controls.row(4, 'select-all').activate()
    expect(controls.draft.profile).toMatchObject({
      skills: true,
      memory: true,
      contextManager: 'auto',
      agentConfig: { backgroundTasks: true },
    })
    controls.row(3, 'select-all').activate()
    expect(Array.isArray(controls.draft.profile.builtinTools)).toBe(true)
    expect(enabledProfileTools(controls.draft.profile.builtinTools)).not.toContain('web_search')
    expect(controls.row(3, 'select-all').label).toBe('Deselect all')
  })
})

describe('setup provider credentials', () => {
  const aws = {
    profiles: ['default', 'review'],
    regions: ['us-west-2', 'eu-west-1'],
    profileRegions: { default: 'us-west-2', review: 'eu-west-1' },
  }

  it.each([
    {
      credentialStatus: 'valid',
      status: 'success',
      description: 'Credentials detected',
      warning: undefined,
    },
    {
      credentialStatus: 'expired',
      status: 'error',
      description: 'Credentials expired',
      warning: 'AWS credentials expired.',
    },
    {
      credentialStatus: 'missing',
      status: 'error',
      description: 'Credentials not found',
      warning: 'AWS credentials were not detected.',
    },
    {
      credentialStatus: 'unavailable',
      status: 'error',
      description: 'Credentials unavailable',
      warning: 'AWS credentials could not be verified.',
    },
  ] as const)(
    'distinguishes $credentialStatus AWS credentials in provider status',
    ({ credentialStatus, status, description, warning }) => {
      const assessment = providerAssessment('bedrock', {}, { ...aws, credentialStatus }, undefined)
      const rows = rowsForStep(
        1,
        'quickstart',
        quickstartDraft(),
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
      for (const provider of ['bedrock', 'bedrock-mantle']) {
        expect(rows.find((row) => row.id === provider)).toMatchObject({
          status,
          description,
        })
      }
      if (warning === undefined) expect(assessment.warning).toBeUndefined()
      else expect(assessment.warning).toContain(warning)
    }
  )

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

  it.each(['process', 'session'] as const)('selects a profile while preserving the explicit %s region', (source) => {
    const environment = effectiveProviderEnvironment(
      { AWS_PROFILE: 'review', AWS_REGION: 'eu-west-1' },
      {
        AWS_PROFILE: { value: 'default', source },
        AWS_REGION: { value: 'us-east-2', source },
      },
      aws
    )
    expect(environment.AWS_PROFILE?.value).toBe('review')
    expect(environment.AWS_REGION?.value).toBe('us-east-2')
  })

  it('offers an editable session-only field when an API key was not detected', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const setEditing = vi.fn()
    const detectedEnvironment: DetectedProviderEnvironment = {}
    const apiKey = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('openai/test-model'),
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

  it('asks for a LiteLLM key only when the proxy requests authentication', () => {
    const environment = { LITELLM_API_KEY: { value: 'rejected', source: 'process' as const } }
    const rows = rowsForStep(
      1,
      'quickstart',
      quickstartDraft('litellm/test-model'),
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
      quickstartDraft('openai/test-model'),
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
      quickstartDraft('openai/test-model'),
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
      quickstartDraft('google/test-model'),
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

  it('keeps ready-provider model controls while hiding credentials', () => {
    const environment = { OPENAI_API_KEY: { value: 'secret', source: 'process' as const } }
    const draft = quickstartDraft('openai/test-model')
    draft.providers = ['bedrock', 'openai']
    const rows = rowsForStep(
      1,
      'customize',
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
    const draft = quickstartDraft(model)
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
    const draft = quickstartDraft('ollama/llama3.2')
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
  it.each(['bedrock', 'bedrock-mantle', 'openai'] as const)(
    'enables every quickstart capability except web_search for %s',
    (provider) => {
      const draft = quickstartDraft(`${provider}/openai.gpt-6.1-sol`)
      expect(enabledProfileTools(draft.profile.builtinTools)).toEqual(
        enabledProfileTools(DEFAULT_HARNESS_AGENT_CONFIG.builtinTools).filter((tool) => tool !== 'web_search')
      )
      expect(draft.profile.builtinPlugins).toEqual(DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins)
      expect(draft.settings).toEqual({ mcpDiscovery: true, skillDiscovery: true, agentMessaging: true })
    }
  )

  it.each([
    ['Exa', 'bedrock', 'exa'],
    ['Native', 'bedrock-mantle', 'native'],
  ] as const)('offers an explicit %s web search opt-in for %s', (label, provider, mode) => {
    const draft = quickstartDraft(`${provider}/openai.gpt-6.1-sol`)
    let profile = draft.profile
    const rows = rowsForStep(
      1,
      'quickstart',
      draft,
      '',
      {},
      {},
      provider,
      [provider],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      (update) => {
        profile = { ...profile, ...update }
      },
      () => {}
    )
    const webSearch = rows.find((row) => row.id === 'quickstart-web-search')
    expect(webSearch?.choices?.map((choice) => [choice.label, choice.active])).toEqual([
      ['Off', true],
      [label, false],
    ])

    webSearch?.choices?.[1]?.activate()

    expect(profileToolEnabled(profile.builtinTools, 'web_search')).toBe(true)
    expect(webSearchFallback(profile.builtinTools)).toBe(mode === 'exa' ? 'exa' : undefined)
  })

  it('keeps the Exa web search opt-in for Bedrock', () => {
    const bedrock = quickstartDraft().profile
    const exa = { ...bedrock, builtinTools: { web_search: 'exa' as const } }
    expect(compatibleProfile(exa).builtinTools).toMatchObject({ web_search: 'exa' })
  })

  it.each([
    ['bedrock/zai.glm-4.7', 'high', 'auto'],
    ['bedrock/zai.glm-4.7', 'off', 'off'],
    ['bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'high', 'high'],
  ] as const)('keeps %s on a supported effort (%s → %s)', (model, effort, expected) => {
    const profile = { ...quickstartDraft().profile, model, effort }
    expect(compatibleProfile(profile).effort).toBe(expected)
  })

  it('keeps an explicit Exa selection visible even when the model supports native search', () => {
    const bedrock = quickstartDraft().profile
    expect(exaWebSearchActive(bedrock)).toBe(false)
    expect(exaWebSearchActive({ ...bedrock, builtinTools: { web_search: 'exa' } })).toBe(true)
    const draft = quickstartDraft('bedrock-mantle/openai.gpt-6.1-sol')
    expect(exaWebSearchActive(draft.profile)).toBe(false)
    draft.profile = { ...draft.profile, builtinTools: { web_search: 'exa' } }
    expect(exaWebSearchActive(draft.profile)).toBe(true)
    expect(builtinToolChoices(draft.profile).find(({ id }) => id === 'web_search')).toMatchObject({
      active: true,
      thirdParty: true,
    })
    const rows = rowsForStep(
      1,
      'quickstart',
      draft,
      '',
      {},
      {},
      'bedrock-mantle',
      ['bedrock-mantle'],
      { profiles: [], regions: [] },
      undefined,
      () => {},
      () => {},
      () => {}
    )
    expect(rows.find(({ id }) => id === 'quickstart-web-search')).toMatchObject({
      description: 'Third-party search via Exa',
      choices: [
        { label: 'Off', active: false },
        { label: 'Exa', active: true },
      ],
    })
  })

  it('opts a profile into Exa by storing the string, whichever form builtinTools uses', () => {
    expect(withWebSearchFallback(['read', 'shell'])).toMatchObject({ read: true, shell: true, web_search: 'exa' })
    expect(withWebSearchFallback({ subagent: false })).toEqual({ subagent: false, web_search: 'exa' })
    expect(webSearchFallback(withWebSearchFallback({}))).toBe('exa')
  })
})
