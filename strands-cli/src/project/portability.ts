import { type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mapWebFetchModelModule, webFetchModelModule } from '../agent/tools.js'
import { containsPath } from '../paths.js'
import { isRecord } from '../values.js'
import { type AgentProjectLanguage } from './import.js'
import { packageName, packageSources, realSource, sourceBase, type PackagedSource } from './packaging.js'

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
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      continue
    }
    const label = `MCP server ${JSON.stringify(name)}`
    for (const field of ['env', 'headers']) {
      const values = server[field]
      if (!isRecord(values)) {
        continue
      }
      for (const [key, value] of Object.entries(values)) {
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

export function validatePortableDependencies(
  dependencies: HarnessAgentConfig['dependencies'],
  language: AgentProjectLanguage
): void {
  const specs = language === 'typescript' ? Object.values(dependencies.typescript) : dependencies.python
  for (const original of specs) {
    let value = original.trim()
    let pathOption = false
    if (language === 'python') {
      if (value.startsWith('#')) continue
      const option = /^(?:--(?:editable|requirement|constraint|find-links)(?:=|\s+)|-[ercf]\s*)/u.exec(value)
      if (option) {
        pathOption = true
        value = value.slice(option[0].length).trim()
      } else if (value.startsWith('-')) {
        continue
      }
      value = value
        .replace(/^[\w.-]+(?:\[[^\]]*\])?\s*@\s*/u, '')
        .split(/[;#]/u, 1)[0]!
        .split(/\s+--/u, 1)[0]!
        .trim()
    }
    const local =
      /^(?:(?:[a-z]+\+)?file:|link:|workspace:|\.{1,2}(?:[/\\]|$)|[/\\]|~[/\\]|[a-z]:)/iu.test(value) ||
      value.includes('\\')
    const remote = /^(?:[a-z][a-z0-9+.-]*:|git@[^:]+:)/iu.test(value)
    const archive =
      language === 'typescript'
        ? /\.(?:tgz|tar(?:\.gz)?)$/iu.test(value)
        : /\.(?:whl|zip|tgz|tar(?:\.(?:gz|bz2|xz))?)(?:\[[^\]]*\])?$/iu.test(value)
    if (local || (!remote && (archive || (language === 'python' && (pathOption || /[/\\]/u.test(value)))))) {
      throw new Error(
        `dependencies.${language} entry ${JSON.stringify(original)} refers to an unpackaged local dependency. Use module references with files, or published/remote packages.`
      )
    }
  }
}

export function packageMcpServers(
  servers: Record<string, unknown>,
  baseDir: string,
  sources: PackagedSource[],
  language: AgentProjectLanguage,
  dependencies: HarnessAgentConfig['dependencies']
): Record<string, unknown> {
  const names = new Set<string>()
  const packages = new Map<string, (path: string) => string>()
  return Object.fromEntries(
    Object.entries(servers).map(([name, raw]) => {
      if (!isRecord(raw)) {
        return [name, raw]
      }
      const { files, ...server } = raw
      if (
        files !== undefined &&
        (!Array.isArray(files) || files.some((path) => typeof path !== 'string' || !path.trim()))
      ) {
        throw new Error(`MCP server ${JSON.stringify(name)} files must contain source paths.`)
      }
      if (typeof server.command !== 'string') {
        return [name, server]
      }
      const declared = (files as string[] | undefined)?.map((path) => realSource(path, false, baseDir)) ?? []
      if (typeof server.cwd === 'string' && server.cwd.includes('${')) {
        if (declared.length > 0) {
          throw new Error(`MCP server ${JSON.stringify(name)} needs a concrete cwd to package its files.`)
        }
        return [name, server]
      }
      const cwd = realSource(typeof server.cwd === 'string' ? server.cwd : '.', false, baseDir)
      if (!lstatSync(cwd).isDirectory()) {
        throw new Error(`MCP server ${JSON.stringify(name)} cwd must be a directory.`)
      }
      const roots = [...declared]
      const localPath = (value: unknown, infer = true): string | undefined => {
        if (typeof value !== 'string' || value.includes('${') || value.startsWith('-')) {
          return undefined
        }
        const candidate = resolve(cwd, value)
        if (!existsSync(candidate)) {
          return undefined
        }
        const path = realSource(value, false, cwd)
        const declaredPath = declared.some((root) => containsPath(root, path))
        if (!infer && !declaredPath) {
          return undefined
        }
        const explicit = value.startsWith('.') || isAbsolute(value)
        const script = /\.(?:[cm]?[jt]s|py|sh)$/iu.test(value)
        if (!explicit && !script && !declaredPath) {
          return undefined
        }
        if (!declared.some((root) => containsPath(root, path))) {
          if (!script || !lstatSync(path).isFile()) {
            throw new Error(
              `MCP server ${JSON.stringify(name)} must declare ${JSON.stringify(value)} in files or use an environment placeholder.`
            )
          }
          roots.push(path)
        }
        return path
      }
      const command = localPath(server.command)
      const inferArguments = /^(?:node|python(?:\d+(?:\.\d+)*)?|(?:ba|da|z)?sh)(?:\.exe)?$/iu.test(
        basename(server.command)
      )
      const args = Array.isArray(server.args) ? server.args.map((value) => localPath(value, inferArguments)) : []
      const needsOtherDependencies =
        language === 'typescript' &&
        dependencies.python.length > 0 &&
        (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/iu.test(basename(server.command)) ||
          [command, ...args].some((path) => path && /\.py$/iu.test(path)))
      if (needsOtherDependencies) {
        throw new Error(
          `The TypeScript export does not install dependencies.python required by MCP server ${JSON.stringify(name)}. Use a self-contained package runner (uvx), export in python, or remove unused dependency declarations.`
        )
      }
      if (roots.length === 0) {
        if (cwd !== realSource('.', false, baseDir)) {
          throw new Error(`MCP server ${JSON.stringify(name)} must declare files for its local cwd.`)
        }
        return [name, { ...server, ...(server.cwd === undefined ? {} : { cwd: '.' }) }]
      }
      const packageRoots = roots.filter(
        (root) => mcpModuleLanguage(root) === 'typescript' || lstatSync(root).isDirectory()
      )
      for (const root of packageRoots) {
        let directory = lstatSync(root).isDirectory() ? root : dirname(root)
        for (;;) {
          const manifest = join(directory, 'package.json')
          if (existsSync(manifest)) {
            roots.push(realSource(manifest, true, directory))
            break
          }
          const parent = dirname(directory)
          if (parent === directory || basename(directory) === 'node_modules') break
          directory = parent
        }
      }
      const key = JSON.stringify([cwd, [...new Set(roots)].sort()])
      let target = packages.get(key)
      if (!target) {
        const destination = `mcp/${packageName(name, names)}`
        target = packageSources(roots, destination, sources, cwd)
        packages.set(key, target)
        if (packageRoots.length > 0 && !roots.some((root) => target!(root) === `${destination}/package.json`)) {
          sources.push({ destination: `${destination}/package.json`, contents: '{}\n' })
        }
      }
      const fromCwd = (path: string): string => `./${relative(target(cwd), target(path)).split(sep).join('/')}`
      return [
        name,
        {
          ...server,
          cwd: `./agent/${target(cwd)}`,
          ...(command ? { command: fromCwd(command) } : {}),
          ...(Array.isArray(server.args)
            ? { args: server.args.map((value, index) => (args[index] ? fromCwd(args[index]) : value)) }
            : {}),
        },
      ]
    })
  )
}

function mcpModuleLanguage(module: string): AgentProjectLanguage | undefined {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(module)) {
    return 'typescript'
  }
  return /\.py$/iu.test(module) ? 'python' : undefined
}

function configurationModules(config: HarnessAgentConfig): (HarnessModuleReference | null)[] {
  return [
    config.modelModule,
    webFetchModelModule(config.builtinTools),
    ...config.tools,
    ...config.subagents,
    ...config.plugins,
    ...config.memoryStores,
    ...config.interventionModules,
    config.sandbox,
    ...Object.values(config.agentConfigModules),
  ]
}

export function portableConfig(
  profile: HarnessAgentConfig,
  language: AgentProjectLanguage,
  skillSources: readonly string[],
  sources: PackagedSource[],
  baseDir = process.cwd()
): HarnessAgentConfig {
  const config = normalizeHarnessAgentConfig(profile)
  const mcpServers = portableMcpServers(config.mcpServers, baseDir)
  validateNoConfigSecrets(config, mcpServers)
  validatePortableDependencies(config.dependencies, language)
  if (language === 'python') {
    validatePortableDependencies(config.dependencies, 'typescript')
    validatePythonMcp(mcpServers)
  }
  const packagedModules = packageModuleSources(config, baseDir, sources)
  const policy = (value: string): string => {
    if (!value.trim().endsWith('.cedar')) {
      return value
    }
    const source = realSource(value.trim(), true, baseDir)
    const destination = `policies/${sources.length}/${basename(source)}`
    sources.push({ source, destination })
    return `./agent/${destination}`
  }
  const reference = (value: HarnessModuleReference): HarnessModuleReference => {
    const referenceLanguage = value.language ?? inferredLanguage(value.module)
    if (referenceLanguage && referenceLanguage !== language) {
      throw new Error(
        `Cannot export ${referenceLanguage} ${value.kind} module ${JSON.stringify(value.module)} as ${language}.`
      )
    }
    if (!isLocalModule(value.module)) {
      requireDependency(config, language, value.module, value.dependency)
      return { ...value, language }
    }
    const roots = value.files?.map((path) => realSource(path, false, baseDir)) ?? []
    const sourceModule =
      language === 'typescript' && !existsSync(resolve(baseDir, value.module))
        ? value.module.replace(/\.([cm]?)js$/u, '.$1ts')
        : value.module
    const modulePath = realSource(sourceModule, language !== 'python', baseDir)
    const packagedPath = packagedModules.get(value)
    if (!packagedPath || !roots.some((root) => containsPath(root, modulePath))) {
      throw new Error(
        `Local ${value.kind} module ${JSON.stringify(value.module)} must declare a files entry containing it.`
      )
    }
    const packagedModule = packagedPath(modulePath)
    return {
      ...value,
      language,
      module: `./agent/${language === 'typescript' ? packagedModule.replace(/\.([cm]?)ts$/u, '.$1js') : packagedModule}`,
      files: roots.map((root) => `./agent/${packagedPath(root)}`),
    }
  }
  return {
    ...config,
    mcpServers: packageMcpServers(mcpServers, baseDir, sources, language, config.dependencies),
    interventions: Array.isArray(config.interventions)
      ? config.interventions.map(policy)
      : typeof config.interventions === 'string'
        ? policy(config.interventions)
        : null,
    modelModule: config.modelModule ? reference(config.modelModule) : null,
    tools: config.tools.map(reference),
    subagents: config.subagents.map(reference),
    plugins: config.plugins.map(reference),
    memoryStores: config.memoryStores.map(reference),
    builtinTools: mapWebFetchModelModule(config.builtinTools, reference),
    interventionModules: config.interventionModules.map(reference),
    sandbox: config.sandbox ? reference(config.sandbox) : null,
    agentConfigModules: Object.fromEntries(
      Object.entries(config.agentConfigModules).map(([key, value]) => [key, reference(value)])
    ),
    skills: skillSources.length > 0 ? [...skillSources] : false,
    session: config.session === true ? { dir: './.agent/sessions' } : config.session,
    memory: config.memory === true ? { dir: './.agent/memory' } : config.memory,
  }
}

function packageModuleSources(
  config: HarnessAgentConfig,
  baseDir: string,
  sources: PackagedSource[]
): Map<HarnessModuleReference, (path: string) => string> {
  const groups: { references: HarnessModuleReference[]; roots: string[]; base: string }[] = []
  for (const reference of configurationModules(config)) {
    if (!reference || !isLocalModule(reference.module)) continue
    const roots = reference.files?.map((path) => realSource(path, false, baseDir)) ?? []
    if (roots.length === 0) continue
    const base = sourceBase(roots)
    const group = { references: [reference], roots, base }
    for (let index = groups.length - 1; index >= 0; index--) {
      const other = groups[index]!
      if (containsPath(group.base, other.base) || containsPath(other.base, group.base)) {
        group.references.push(...other.references)
        group.roots.push(...other.roots)
        group.base = sourceBase(group.roots)
        groups.splice(index, 1)
      }
    }
    groups.push(group)
  }
  const categories = groups.map(({ references }) => {
    const kinds = new Set(references.map((reference) => reference.kind))
    if (kinds.size > 1) return 'shared'
    const kind = references[0]!.kind
    return kind === 'tool' || kind === 'plugin' || kind === 'subagent' ? `${kind}s` : `extensions/${kind}`
  })
  const names = new Set<string>()
  const packaged = new Map<HarnessModuleReference, (path: string) => string>()
  for (const [index, group] of groups.entries()) {
    const category = categories[index]!
    const destination =
      categories.filter((value) => value === category).length > 1
        ? `${category}/${packageName(basename(group.base), names)}`
        : category
    const target = packageSources(group.roots, destination, sources)
    for (const reference of group.references) {
      packaged.set(reference, target)
    }
  }
  return packaged
}

function portableMcpServers(value: HarnessAgentConfig['mcpServers'], baseDir = process.cwd()): Record<string, unknown> {
  if (typeof value !== 'string') {
    return mcpServerMap(value)
  }
  const path = realSource(value, true, baseDir)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`MCP config ${JSON.stringify(value)} must be valid JSON.`, { cause: error })
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP config ${JSON.stringify(value)} must contain a server map.`)
  }
  return mcpServerMap(parsed)
}

function mcpServerMap(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.mcpServers
  if (nested === undefined) {
    return value
  }
  if (!isRecord(nested)) {
    throw new Error('mcpServers must contain a server map.')
  }
  return nested
}

function inferredLanguage(module: string): AgentProjectLanguage | undefined {
  if (/\.[cm]?[jt]sx?$/iu.test(module)) {
    return 'typescript'
  }
  return /\.py$/iu.test(module) ? 'python' : undefined
}

function requireDependency(
  config: HarnessAgentConfig,
  language: AgentProjectLanguage,
  module: string,
  explicitDependency?: string
): void {
  const packageName =
    explicitDependency ??
    (language === 'typescript'
      ? module.startsWith('@')
        ? module.split('/').slice(0, 2).join('/')
        : module.split('/')[0]!
      : module.split('.')[0]!)
  if (language === 'typescript') {
    if (!Object.hasOwn(config.dependencies.typescript, packageName) || !config.dependencies.typescript[packageName]) {
      throw new Error(
        `Module ${JSON.stringify(module)} requires dependencies.typescript[${JSON.stringify(packageName)}].`
      )
    }
    return
  }
  const normalized = packageName.toLowerCase().replace(/[-_.]+/gu, '-')
  const declared = config.dependencies.python.some(
    (dependency) =>
      dependency
        .split(/(?:<|>|=|!|~|\[|\(|;|@)/u, 1)[0]!
        .trim()
        .toLowerCase()
        .replace(/[-_.]+/gu, '-') === normalized
  )
  if (!declared) {
    throw new Error(`Module ${JSON.stringify(module)} requires a matching dependencies.python entry.`)
  }
}

// Shared by export and configuration editing: resolved MCP servers are scanned so file-backed
// configuration receives the same credential checks as an inline map.
export function validateNoConfigSecrets(
  config: HarnessAgentConfig,
  mcpServers: Record<string, unknown> = portableMcpServers(config.mcpServers)
): void {
  scanConfigSecrets(config, mcpServers)
}

function validatePythonMcp(servers: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(servers)) {
    if (isRecord(raw) && 'tasksConfig' in raw) {
      throw new Error(`MCP server ${JSON.stringify(name)} uses tasksConfig, which the Python harness cannot reproduce.`)
    }
  }
}

function isLocalModule(module: string): boolean {
  return module.startsWith('.') || isAbsolute(module)
}
