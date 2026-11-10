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
