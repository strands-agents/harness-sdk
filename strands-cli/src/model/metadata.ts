import { type Model } from '@strands-agents/sdk'

// Mirrors entries in strands-ts/src/models/defaults.ts (the source of these values) that the CLI's minimum
// published @strands-agents/sdk release lacks. Remove once the minimum SDK version includes them.
const FALLBACK_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['claude-opus-5-5', 1_000_000],
  ['claude-fable-5-1', 1_000_000],
  ['claude-sonnet-5-5', 1_000_000],
  ['claude-haiku-5-5', 1_000_000],
  ['anthropic.claude-opus-5-5', 1_000_000],
  ['anthropic.claude-fable-5-1', 1_000_000],
  ['anthropic.claude-sonnet-5-5', 1_000_000],
  ['anthropic.claude-haiku-5-5', 1_000_000],
  ['zai.glm-4.7', 203_000],
  ['zai.glm-4.7-flash', 203_000],
  ['zai.glm-5', 200_000],
  ['zai.glm-5.3', 1_000_000],
  ['openai.gpt-oss-120b', 128_000],
  ['openai.gpt-oss-120b-1:0', 128_000],
  ['openai.gpt-oss-20b', 128_000],
  ['openai.gpt-oss-20b-1:0', 128_000],
  ['openai.gpt-oss-safeguard-120b', 128_000],
  ['openai.gpt-oss-safeguard-20b', 128_000],
  ['openai.gpt-6-astra', 1_050_000],
  ['openai.gpt-6.1-sol', 1_000_000],
  ['openai.gpt-6.1-terra', 1_050_000],
  ['openai.gpt-6-sol', 1_050_000],
  ['openai.gpt-6-luna', 1_050_000],
  ['openai.gpt-5.6-sol', 1_050_000],
  ['openai.gpt-5.6-terra', 1_050_000],
  ['openai.gpt-5.6-luna', 1_050_000],
  ['openai.gpt-5.5', 1_050_000],
  ['openai.gpt-5.4', 1_050_000],
  ['mistral.mistral-large-3-675b-instruct', 256_000],
  ['mistral.ministral-3-14b-instruct', 128_000],
  ['mistral.ministral-3-8b-instruct', 128_000],
  ['mistral.ministral-3-3b-instruct', 128_000],
  ['mistral.magistral-small-2509', 128_000],
  ['mistral.pixtral-large-2502-v1:0', 128_000],
  ['mistral.mistral-small-2402-v1:0', 32_000],
  ['mistral.mistral-large-2402-v1:0', 32_000],
  ['google.gemma-4-31b', 256_000],
  ['google.gemma-4-26b-a4b', 256_000],
  ['google.gemma-4-e2b', 128_000],
  ['xai.grok-4.7', 524_288],
  ['xai.grok-4.6', 500_000],
  ['xai.grok-4.3', 1_000_000],
  ['chat-latest', 272_000],
  ['gpt-6.1-sol', 1_050_000],
  ['gpt-6.1-terra', 1_050_000],
  ['gpt-6-sol', 1_050_000],
  ['gpt-6-luna', 1_050_000],
  ['gpt-oss-120b', 131_072],
  ['gpt-oss-20b', 131_072],
  ['gemini-4-argon', 1_048_576],
  ['gemini-3.8-flash', 1_048_576],
  ['gemini-3.7-flash', 1_048_576],
])

export function contextWindowLimit(model: Model): number | undefined {
  const configured = model.getConfig().contextWindowLimit
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return configured
  }

  // Keep in step with BEDROCK_REGION_PREFIXES in strands-ts/src/models/defaults.ts, plus 'in' (#4893).
  const modelId = (model.modelId ?? '')
    .split('/')
    .at(-1)
    ?.replace(/^(?:global|apac|us-gov|us|eu|ap|in|au|jp)\./, '')
  return modelId === undefined ? undefined : FALLBACK_CONTEXT_WINDOWS.get(modelId)
}

const VERSIONED_MODELS = [
  [/^gpt-(\d+o?)(?:[.-](\d+))?(?:-(.+))?$/, 'GPT-'],
  [/^gemini-(\d+)(?:[.-](\d+))?(?:-(.+))?$/, 'Gemini '],
  [/^llama-?(\d+)(?:[.-](\d+))?(?:-(.+))?$/, 'Llama '],
  [/^grok-(\d+)(?:[.-](\d+))?(?:-(.+))?$/, 'Grok '],
] as const

export function modelDisplayName(model: string): string {
  const original = model.trim()
  if (!original || /\s/u.test(original)) {
    return original
  }

  const identifier = original
    .replace(/^bedrock\//, '')
    .replace(/^(?:apac|au|eu|global|jp|us)\./, '')
    .replace(/^(?:amazon|anthropic|google|meta|mistral|openai|xai)\./, '')
    .replace(/-v\d+(?::\d+)?$/u, '')
    .replace(/-\d{8}$/u, '')
    .toLowerCase()

  const claudeTierFirst = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?/.exec(identifier)
  if (claudeTierFirst) {
    return `Claude ${titleWord(claudeTierFirst[1]!)} ${version(claudeTierFirst[2]!, claudeTierFirst[3])}`
  }

  const claudeVersionFirst = /^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable)/.exec(identifier)
  if (claudeVersionFirst) {
    return `Claude ${titleWord(claudeVersionFirst[3]!)} ${version(claudeVersionFirst[1]!, claudeVersionFirst[2])}`
  }

  for (const [pattern, prefix] of VERSIONED_MODELS) {
    const match = pattern.exec(identifier)
    if (match) {
      return [`${prefix}${version(match[1]!, match[2])}`, displaySuffix(match[3])].filter(Boolean).join(' ')
    }
  }

  const gptOss = /^gpt-oss-(.+)$/.exec(identifier)
  if (gptOss) {
    return `GPT OSS ${displaySuffix(gptOss[1])}`
  }

  const nova = /^nova-(.+)$/.exec(identifier)
  if (nova) {
    return `Nova ${displaySuffix(nova[1])}`
  }

  return original
}

function version(major: string, minor?: string): string {
  return minor ? `${major}.${minor}` : major
}

function displaySuffix(value?: string): string {
  if (!value) {
    return ''
  }
  return value
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((word) => (/^\d+b$/u.test(word) ? word.toUpperCase() : titleWord(word)))
    .join(' ')
}

function titleWord(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1)
}
