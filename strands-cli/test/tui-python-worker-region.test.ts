import { existsSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'
import { PythonBackend, type PythonOptions } from '../src/tui/project/python.js'
import { pythonEnvironment, pythonExecutable } from './fixtures/python-runtime.js'

const bedrockModel = 'bedrock/anthropic.claude-3-haiku-20240307-v1:0'

describe.skipIf(!existsSync(pythonExecutable))('Python worker provider resolution', { timeout: 15_000 }, () => {
  let root: string
  const backends: PythonBackend[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-python-worker-region-'))
    await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
    await writeFile(join(root, 'config'), '')
    await writeFile(join(root, 'credentials'), '')
    for (const key of [
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      vi.stubEnv(key, undefined)
    }
    vi.stubEnv('AWS_CONFIG_FILE', join(root, 'config'))
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(root, 'credentials'))
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'test-token')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    applyProviderEnvironmentValues({})
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function openAgent(
    model = JSON.stringify(bedrockModel),
    overrides?: PythonOptions['overrides'],
    prelude = ''
  ): Promise<PythonBackend> {
    const entrypoint = join(root, 'agent.py')
    await writeFile(
      entrypoint,
      `import os
from strands.models import BedrockModel
from strands_harness import create_harness
${prelude}
agent = create_harness(
    model=${model}, effort="off", caching=False, builtin_tools=[], builtin_plugins=[],
    session=False, memory=False, skills=False, context_manager=False,
)
agent.name = agent.model.client.meta.region_name if isinstance(agent.model, BedrockModel) else type(agent.model).__name__
`
    )
    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, ...(overrides ? { overrides } : {}) },
      AbortSignal.timeout(15_000)
    )
    backends.push(backend)
    return backend
  }

  it.each([
    'None',
    JSON.stringify(bedrockModel),
    JSON.stringify(bedrockModel.slice('bedrock/'.length)),
    JSON.stringify('bedrock-mantle/openai.gpt-5.6-sol'),
  ])(
    'leaves authored model resolution to the SDK for %s',
    async (model) => {
      await expect(openAgent(model)).resolves.toBeInstanceOf(PythonBackend)
    },
    15_000
  )

  it('applies model overrides to direct generated source', async () => {
    expect((await openAgent('"openai/gpt-5"', { model: bedrockModel, session: false })).info().model).toBe(bedrockModel)
    expect((await openAgent(undefined, { model: 'openai/gpt-5' })).info().model).toBe('openai/gpt-5')
  })

  it('drops removed config keys instead of forwarding them to Agent', async () => {
    const overrides = { thinking: null } as unknown as PythonOptions['overrides']
    await expect(openAgent(undefined, overrides)).resolves.toBeInstanceOf(PythonBackend)
  })

  it('leaves a supplied Model instance untouched', async () => {
    const backend = await openAgent('BedrockModel(model_id="custom", region_name="eu-west-1")')
    expect(backend.name).toBe('eu-west-1')
  })

  it.each(['AWS_REGION', 'AWS_DEFAULT_REGION'])('accepts %s and sends it to the SDK', async (key) => {
    vi.stubEnv(key, 'us-east-2')
    expect((await openAgent()).name).toBe('us-east-2')
  })

  it.each([undefined, 'eu-west-1'])(
    'prefers AWS_REGION over AWS_DEFAULT_REGION=%s and the default profile in the child only',
    async (defaultRegion) => {
      await writeFile(join(root, 'config'), '[default]\nregion=us-west-2\n')
      vi.stubEnv('AWS_REGION', 'us-east-2')
      vi.stubEnv('AWS_DEFAULT_REGION', defaultRegion)
      expect((await openAgent()).name).toBe('us-east-2')
      expect(process.env.AWS_DEFAULT_REGION).toBe(defaultRegion)
    }
  )

  it('accepts the actual selected profile region when no region variables reach the factory', async () => {
    await writeFile(join(root, 'config'), '[default]\nregion=us-west-2\n[profile selected]\nregion=us-east-2\n')
    vi.stubEnv('AWS_PROFILE', 'selected')
    const backend = await openAgent(
      undefined,
      undefined,
      'os.environ.pop("AWS_REGION", None)\nos.environ.pop("AWS_DEFAULT_REGION", None)'
    )
    expect(backend.name).toBe('us-east-2')
  })

  it('leaves profile fallback behavior to the SDK', async () => {
    await writeFile(join(root, 'config'), '[default]\nregion=us-west-2\n[profile selected]\noutput=json\n')
    vi.stubEnv('AWS_PROFILE', 'selected')
    expect((await openAgent()).name).toBe('us-west-2')
  })

  it('allows IAM without a bearer token or explicit region', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fake-access-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fake-secret-key')
    expect((await openAgent()).info().model).toBe(bedrockModel.slice('bedrock/'.length))
  })
})
