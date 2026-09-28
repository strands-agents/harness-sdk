import type { HarnessAgentConfig } from '@strands-agents/harness'

const SECRET_KEY_PATTERN =
  /(?:secret|token|password|passphrase|credential|authorization|api.?key|access.?key|private.?key|pwd|connection.?string)/iu
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`${SECRET_KEY_PATTERN.source}\\s*[=:]\\s*\\S`, 'iu')
const SECRET_FLAG_PATTERN = new RegExp(`^--?[\\w-]*${SECRET_KEY_PATTERN.source}[\\w-]*$`, 'iu')
// Well-known credential shapes (OpenAI/Anthropic sk-, GitHub gh*_, GitLab glpat-, AWS access key
// IDs, Slack xox*, Google AIza, two-segment JWTs) so a bare token in a field with an innocent
// name still fails instead of exporting.
const BARE_CREDENTIAL_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[oprsu]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{17,})\b/u

export function scanConfigSecrets(config: HarnessAgentConfig, mcpServers: Record<string, unknown>): void {
  validatePortableMcp(mcpServers)
  // `dependencies` is keyed by package names, which legitimately contain words like "token";
  // `name`/`description`/`instructions` are free prose, where "password: never share it" is
  // legitimate text rather than a credential assignment.
  const {
    dependencies: _dependencies,
    name: _name,
    description: _description,
    instructions: _instructions,
    ...scanned
  } = config
  validateNoEmbeddedSecrets({ ...scanned, mcpServers }, 'config')
  for (const value of [...Object.values(config.dependencies.typescript), ...config.dependencies.python].flatMap(
    (value) => [value, ...(value.match(/[a-z][a-z0-9+.-]*:\/\/\S+/giu) ?? [])]
  )) {
    validateNoSecretValue(value, 'Dependency')
  }
}

function validatePortableMcp(servers: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const server = raw as Record<string, unknown>
    const label = `MCP server ${JSON.stringify(name)}`
    for (const field of ['env', 'headers']) {
      const values = server[field]
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        continue
      }
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value !== 'string' || !isEnvironmentReference(value)) {
          throw new Error(`${label} ${field}.${key} must use an environment placeholder.`)
        }
      }
    }
    for (const field of ['command', 'url', 'cwd']) {
      if (typeof server[field] === 'string') {
        validateNoSecretValue(server[field], `${label} ${field}`)
      }
    }
    if (Array.isArray(server.args)) {
      validateNoSecretArgs(server.args, label)
    }
  }
}

// Key-name scan plus value scan: any secret-named field must hold a placeholder, wherever it
// sits in the config (including `agentConfig` and objects nested in arrays), and every string
// value is checked for credential *shapes* the key names miss (URL userinfo, `key=value`
// assignments). Only string values can error, so a server or module *named* after a secret
// doesn't false-positive.
function validateNoEmbeddedSecrets(value: unknown, path: string, secretKey = false): void {
  if (typeof value === 'string') {
    if (secretKey && !isEnvironmentReference(value)) {
      throw new Error(`${path} must use an environment placeholder.`)
    }
    validateNoSecretValue(value, path)
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNoEmbeddedSecrets(entry, `${path}[${index}]`, secretKey))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateNoEmbeddedSecrets(entry, `${path}.${key}`, SECRET_KEY_PATTERN.test(key))
  }
}

// Value scan for strings whose *contents* can carry a credential the key-name scan misses:
// URL userinfo, and `key=value`-shaped assignments in URLs, commands, and args.
// Placeholders are stripped first (not treated as a pass): `?api_key=${KEY}` stays legal while
// a literal credential sitting next to a placeholder is still caught.
function validateNoSecretValue(value: string, label: string): void {
  const literal = value.replace(/\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/gu, '')
  // Any literal userinfo is a credential (`https://<token>@host` no less than `user:pass@`); the
  // one non-colon character keeps a fully-placeholdered `${USER}:${PASS}@` (stripped to `:@`) legal.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*[^:/@\s][^/@\s]*@/iu.test(literal)) {
    throw new Error(`${label} embeds credentials in the URL; use an environment placeholder instead.`)
  }
  if (SECRET_ASSIGNMENT_PATTERN.test(literal)) {
    throw new Error(`${label} must use an environment placeholder.`)
  }
  if (BARE_CREDENTIAL_PATTERN.test(literal)) {
    throw new Error(`${label} appears to contain a credential; use an environment placeholder instead.`)
  }
}

function validateNoSecretArgs(args: readonly unknown[], label: string): void {
  args.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      return
    }
    validateNoSecretValue(arg, `${label} args[${index}]`)
    const next = args[index + 1]
    if (SECRET_FLAG_PATTERN.test(arg) && typeof next === 'string' && !isEnvironmentReference(next)) {
      throw new Error(`${label} args[${index + 1}] must use an environment placeholder.`)
    }
  })
}

// Anchored: the value must *be* placeholders (an optional scheme word like `Bearer` may precede
// them, and `${SCHEME} ${TOKEN}` is fine), so a literal credential alongside a placeholder never
// passes as "safe".
function isEnvironmentReference(value: string): boolean {
  return /^\s*(?:[A-Za-z]\w*\s+)?\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}(?:\s+\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\})*\s*$/u.test(
    value
  )
}
