import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HarnessAgentConfig } from '@strands-agents/harness'
import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'
import { unzipSync } from 'fflate'
import { ZipFile } from 'yazl'

import { webFetchModelId } from '../builtin-tools.js'
import { resolveSkillPaths } from '../skills.js'
import { PROVIDER_PACKAGES } from '../provider/packages.js'
import { chooseSaveFile } from '../terminal/directory-picker.js'
import { agentProjectSource } from './source.js'
import { AGENT_ENTRYPOINT_FILE, archiveExecutableModes, regularFile, resolveProjectEntrypoint } from './archive.js'
import type { AgentProjectLanguage, ImportedAgentProject } from './import.js'
import { portableConfig, validateNoConfigSecrets } from './configuration.js'
import { containsPath, expandHome } from '../paths.js'
import { isRecord } from '../values.js'
import {
  assertPortablePathComponent,
  hasIgnoredDirectory,
  IGNORED_DIRECTORIES,
  MAX_PROJECT_BYTES,
  type PackagedSource,
} from './packaging.js'

export type AgentProjectOutput = 'zip' | 'directory'

interface SkillPackage {
  id: string
  path: string
}

/** @internal Shared configuration and packaged paths for the preview and exported project. */
export function prepareAgentProject(
  profile: HarnessAgentConfig,
  language: AgentProjectLanguage,
  skillPaths: readonly string[],
  baseDir = process.cwd()
): { config: HarnessAgentConfig; skills: SkillPackage[]; sources: PackagedSource[] } {
  const localSkillPaths = skillPaths
    .filter((path) => !path.startsWith('https://'))
    .map((path) => resolve(baseDir, path))
  const optionalSkillPaths = new Set(profile.skills === true ? [resolve(baseDir, '.agent', 'skills')] : [])
  const skills = discoverSkillPackages(localSkillPaths, optionalSkillPaths)
  const exportedSkillSources = portableSkillSources(skillPaths, skills.length > 0)
  const sources: PackagedSource[] = []
  const config = portableConfig(profile, language, exportedSkillSources, sources, baseDir)
  return { config, skills, sources }
}

export async function exportAgentProject(
  profile: HarnessAgentConfig,
  language: AgentProjectLanguage,
  skillPaths: readonly string[],
  baseDir = process.cwd(),
  destination?: string,
  output: AgentProjectOutput = 'zip'
): Promise<string | undefined> {
  const selectedDestination =
    destination ??
    (output === 'zip'
      ? await chooseSaveFile(
          `Export ${language === 'typescript' ? 'TypeScript' : 'Python'} harness project`,
          exportFileName(profile.name, language)
        )
      : undefined)
  if (!selectedDestination) {
    return undefined
  }
  const path =
    output === 'directory' || selectedDestination.toLowerCase().endsWith('.zip')
      ? selectedDestination
      : `${selectedDestination}.zip`
  return writeAgentProject(profile, language, skillPaths, path, baseDir, destination === undefined, output)
}

export function exportFileName(name: string, language: AgentProjectLanguage): string {
  return `${slug(name)}-${language}.zip`
}

export function exportDirectoryName(name: string): string {
  return slug(name)
}

/**
 * Exports the saved setup profile to `destination`, resolved against `cwd`. Agents authored in code keep
 * their session and memory paths in source, so they export from chat, where those paths are loaded.
 */
export async function exportSavedAgent(
  saved: { profile: HarnessAgentConfig; profileBaseDir?: string | null; agentProject?: string },
  language: AgentProjectLanguage,
  destination: string,
  cwd = process.cwd()
): Promise<string> {
  if (saved.agentProject) {
    throw new Error('This agent is authored in code. Export it from chat with /export.')
  }
  const baseDir = saved.profileBaseDir ?? cwd
  const skills = saved.profile.skills
  const path = resolve(cwd, expandHome(destination))
  const zipPath = path.toLowerCase().endsWith('.zip') ? path : `${path}.zip`
  return writeAgentProject(
    saved.profile,
    language,
    resolveSkillPaths(typeof skills === 'object' ? [...skills] : skills, baseDir, false),
    zipPath,
    baseDir,
    false
  )
}

export async function writeAgentProject(
  profile: HarnessAgentConfig,
  language: AgentProjectLanguage,
  skillPaths: readonly string[],
  destination: string,
  baseDir = process.cwd(),
  overwrite = true,
  output: AgentProjectOutput = 'zip'
): Promise<string> {
  const { config, skills, sources } = prepareAgentProject(profile, language, skillPaths, baseDir)
  const privatePaths = resolvePrivatePaths(profilePrivatePaths(profile), baseDir)
  const files = language === 'typescript' ? typescriptProject(config) : pythonProject(config)
  const zip = new ZipFile()
  let bytes = 0
  const addBytes = (size: number): void => {
    bytes += size
    if (bytes > MAX_PROJECT_BYTES) {
      throw new Error('The exported agent project exceeds 50 MB.')
    }
  }
  for (const [path, contents] of Object.entries(files)) {
    assertPortableArchivePath(path)
    const buffer = Buffer.from(contents)
    addBytes(buffer.length)
    zip.addBuffer(buffer, path, { compress: false, mode: 0o100644 })
  }
  for (const skill of skills) {
    addPath(zip, skill.path, `agent/skills/${skill.id}`, addBytes, privatePaths)
  }
  for (const source of sources) {
    if ('contents' in source) {
      assertPortableArchivePath(`agent/${source.destination}`)
      const buffer = Buffer.from(source.contents)
      addBytes(buffer.length)
      zip.addBuffer(buffer, `agent/${source.destination}`, { compress: false, mode: 0o100644 })
    } else if (source.directoryOnly) {
      assertPortableArchivePath(`agent/${source.destination}`)
      zip.addEmptyDirectory(`agent/${source.destination}`)
    } else {
      addPath(zip, source.source, `agent/${source.destination}`, addBytes, privatePaths)
    }
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeProject(zip, destination, overwrite, output)
  return destination
}

function profilePrivatePaths(profile: HarnessAgentConfig): string[] {
  const paths: string[] = []
  if (profile.session !== false) {
    paths.push(typeof profile.session === 'object' ? (profile.session.dir ?? '.agent/sessions') : '.agent/sessions')
  }
  if (profile.memory !== false) {
    paths.push(typeof profile.memory === 'object' ? (profile.memory.dir ?? '.agent/memory') : '.agent/memory')
  }
  return paths
}

export async function exportSourceProject(
  project: ImportedAgentProject,
  name: string,
  language: AgentProjectLanguage,
  privatePaths: readonly string[] = [],
  destination?: string,
  output: AgentProjectOutput = 'zip'
): Promise<string | undefined> {
  if (language !== project.language) {
    throw new Error(
      `This agent is authored in ${project.language}; export it in the same language to preserve its code.`
    )
  }
  const root = realpathSync(project.root)
  const privateDirectories = resolvePrivatePaths(privatePaths, root)
  if (privateDirectories.some((path) => containsPath(path, root))) {
    throw new Error(
      'The agent stores private state in its source folder. Use a separate session and memory directory before exporting.'
    )
  }
  const selected =
    destination ??
    (output === 'zip' ? await chooseSaveFile('Export agent project', `${slug(name)}-${language}.zip`) : undefined)
  if (!selected) {
    return undefined
  }
  const path = output === 'directory' || selected.toLowerCase().endsWith('.zip') ? selected : `${selected}.zip`
  const excluded = new Set([
    '.agent/sessions',
    '.agent/memory',
    '.env',
    '.env.local',
    '.strands-dependencies',
    AGENT_ENTRYPOINT_FILE,
    posixRelative(root, path),
    ...privateDirectories.map((path) => posixRelative(root, path)),
  ])
  const entrypoint = resolveProjectEntrypoint(
    root,
    relative(root, realpathSync(project.entrypoint)).split(sep).join('/')
  )
  if (
    !entrypoint ||
    hasIgnoredDirectory(relative(root, entrypoint)) ||
    [...excluded].some((path) => containsPath(resolve(root, path), entrypoint))
  ) {
    throw new Error(
      'The selected agent source file must be inside the exported project and outside excluded directories.'
    )
  }
  validateLocalDependencies(root, excluded)
  const zip = new ZipFile()
  let bytes = 0
  addDirectory(
    zip,
    root,
    '',
    (size) => {
      bytes += size
      if (bytes > MAX_PROJECT_BYTES) throw new Error('The exported agent project exceeds 50 MB.')
    },
    excluded
  )
  const marker = join(root, AGENT_ENTRYPOINT_FILE)
  const existing = regularFile(marker) ? readFileSync(marker) : undefined
  zip.addBuffer(
    existing && resolveProjectEntrypoint(root, existing.toString().trim()) === entrypoint
      ? existing
      : Buffer.from(`${relative(root, entrypoint).split(sep).join('/')}\n`),
    AGENT_ENTRYPOINT_FILE,
    { compress: false }
  )
  await mkdir(dirname(path), { recursive: true })
  await writeProject(zip, path, destination === undefined, output)
  return path
}

function resolvePrivatePaths(paths: readonly string[], baseDir: string): string[] {
  return paths.map((path) => {
    const absolute = resolve(baseDir, expandHome(path))
    try {
      return realpathSync(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return absolute
    }
  })
}

function validateLocalDependencies(root: string, excluded: ReadonlySet<string>): void {
  const visited = new Set<string>()
  const visit = (directory: string): void => {
    if (visited.has(directory)) return
    visited.add(directory)
    const manifest = join(directory, 'package.json')
    if (!regularFile(manifest)) return
    const document = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/u, '')) as Record<string, unknown>
    for (const field of ['dependencies', 'optionalDependencies', ...(directory === root ? ['devDependencies'] : [])]) {
      const dependencies = document[field]
      if (!isRecord(dependencies)) continue
      for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== 'string') continue
        const local = version.startsWith('file:') ? version.slice(5) : version
        if (!version.startsWith('file:') && !/^(?:\.{1,2}[/\\]|~\/)/u.test(local) && !isAbsolute(local)) continue
        const decoded = decodeURIComponent(local)
        if (isAbsolute(decoded) || decoded.startsWith('~/')) {
          throw new Error(
            `Local dependency ${JSON.stringify(name)} in ${manifest} must use a relative path inside the exported project.`
          )
        }
        const source = resolve(directory, decoded)
        let target: string
        try {
          target = realpathSync(source)
        } catch (error) {
          throw new Error(`Local dependency ${JSON.stringify(name)} in ${manifest} cannot be read: ${source}`, {
            cause: error,
          })
        }
        if (
          !containsPath(root, target) ||
          hasIgnoredDirectory(relative(root, target)) ||
          [...excluded].some((entry) => containsPath(resolve(root, entry), target))
        ) {
          throw new Error(
            `Local dependency ${JSON.stringify(name)} in ${manifest} is outside the exported source: ${source}. ` +
              'Move it inside the project and update its dependency path before exporting.'
          )
        }
        if (lstatSync(target).isDirectory()) visit(target)
      }
    }
  }
  visit(root)
}

function typescriptProject(config: HarnessAgentConfig): Record<string, string> {
  return {
    'agent/agent.ts': agentProjectSource(config, 'typescript'),
    'package.json': `${JSON.stringify(
      {
        name: slug(config.name),
        private: true,
        version: '0.1.0',
        type: 'module',
        engines: { node: '>=22.9.0' },
        scripts: {
          build: 'tsc && node build.mjs',
          check: 'tsc --noEmit',
        },
        dependencies: {
          '@strands-agents/harness': `^${harnessVersion()}`,
          ...typescriptProviderDependencies(config),
          ...config.dependencies.typescript,
        },
        devDependencies: { '@types/node': '^24.3.0', tsx: '^4.20.6', typescript: '^5.9.2' },
      },
      null,
      2
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          allowJs: true,
          resolveJsonModule: true,
          strict: true,
          noImplicitAny: false,
          skipLibCheck: true,
          rootDir: '.',
          outDir: 'dist',
        },
        include: ['agent/**/*'],
      },
      null,
      2
    )}\n`,
    'build.mjs': `import { cpSync } from 'node:fs'

cpSync('agent', 'dist/agent', {
  recursive: true,
  filter: (source) => !/\\.[cm]?[jt]sx?$/.test(source),
})
`,
    '.env.example': environmentTemplate(config),
    '.gitignore': 'node_modules/\ndist/\n.env\n.env.local\n.agent/memory/\n.agent/sessions/\n',
    'README.md': projectReadme(config, 'typescript'),
  }
}

function pythonProject(config: HarnessAgentConfig): Record<string, string> {
  return {
    'agent/agent.py': agentProjectSource(config, 'python'),
    'agent/__init__.py': '',
    ...(Object.keys(config.dependencies.typescript).length > 0
      ? {
          'package.json': `${JSON.stringify(
            { name: slug(config.name), private: true, dependencies: config.dependencies.typescript },
            null,
            2
          )}\n`,
        }
      : {}),
    'requirements.txt': [
      `strands-harness${pythonProviderExtras(config)}${harnessPythonSpecifier()}`,
      ...(hasCedarPolicy(config) ? ['strands-agents[cedar]'] : []),
      ...config.dependencies.python,
      '',
    ].join('\n'),
    'pyproject.toml': `[project]
name = ${JSON.stringify(slug(config.name))}
version = "0.1.0"
description = ${JSON.stringify(config.description)}
requires-python = ">=3.10"
`,
    '.env.example': environmentTemplate(config),
    '.gitignore': '.venv/\nnode_modules/\n__pycache__/\n.env\n.env.local\n.agent/memory/\n.agent/sessions/\n',
    'README.md': projectReadme(config, 'python'),
  }
}

function modelProviders(config: HarnessAgentConfig): string[] {
  return [config.model, webFetchModelId(config.builtinTools)]
    .filter((model): model is string => model !== null)
    .map((model) => (model.includes('/') ? model.slice(0, model.indexOf('/')) : 'bedrock'))
}

function typescriptProviderDependencies(config: HarnessAgentConfig): Record<string, string> {
  const packages: Readonly<Record<string, string | undefined>> = PROVIDER_PACKAGES
  const manifest = JSON.parse(readFileSync(join(typescriptPackageRoot(), 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>
  }
  const dependencies: Record<string, string> = {}
  for (const provider of modelProviders(config)) {
    const name = packages[provider]
    if (name) {
      dependencies[name] = manifest.peerDependencies[name]!
    }
  }
  if (hasCedarPolicy(config)) {
    const cli = JSON.parse(readFileSync(join(packageRoot(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    dependencies['@cedar-policy/cedar-wasm'] = cli.dependencies['@cedar-policy/cedar-wasm']!
  }
  return dependencies
}

function pythonProviderExtras(config: HarnessAgentConfig): string {
  const extras = modelProviders(config).flatMap((provider) => {
    if (provider === 'bedrock') {
      return []
    }
    return [provider === 'bedrock-mantle' ? 'openai' : provider === 'google' ? 'gemini' : provider]
  })
  return extras.length > 0 ? `[${[...new Set(extras)].sort().join(',')}]` : ''
}

function hasCedarPolicy(config: HarnessAgentConfig): boolean {
  const values = Array.isArray(config.interventions) ? config.interventions : [config.interventions]
  return values.some((value) => value?.trim().endsWith('.cedar'))
}

function environmentTemplate(config: HarnessAgentConfig): string {
  const serialized = JSON.stringify(config.mcpServers)
  const names = [...serialized.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]!)
  const providerKeys: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    ollama: 'OLLAMA_HOST',
    litellm: 'LITELLM_BASE_URL',
  }
  for (const provider of modelProviders(config)) {
    const key = providerKeys[provider]
    if (key) {
      names.push(key)
    }
  }
  return [...new Set(names)]
    .sort()
    .map((name) => `${name}=\n`)
    .join('')
}

function projectReadme(config: HarnessAgentConfig, language: AgentProjectLanguage): string {
  const python = language === 'python'
  const install = python
    ? ['python3 -m venv .venv', 'source .venv/bin/activate', 'python -m pip install -r requirements.txt']
    : ['npm install']
  const windowsInstall = python
    ? ['python -m venv .venv', '.\\.venv\\Scripts\\Activate.ps1', 'python -m pip install -r requirements.txt']
    : ['npm install']
  if (python && Object.keys(config.dependencies.typescript).length > 0) {
    install.push('npm install')
    windowsInstall.push('npm install')
  }
  return [
    `# ${config.name}`,
    '',
    config.description,
    '',
    '## Setup on macOS or Linux',
    '',
    '```bash',
    ...install,
    'cp .env.example .env',
    '# Set credentials in .env or use your existing provider credential chain.',
    'strands --agent . --env-file .env',
    '```',
    '',
    '## Setup on Windows PowerShell',
    '',
    '```powershell',
    ...windowsInstall,
    'Copy-Item .env.example .env',
    '# Set credentials in .env or use your existing provider credential chain.',
    'strands --agent . --env-file .env',
    '```',
    '',
    `Edit \`agent/${python ? 'agent.py' : 'agent.ts'}\` to change the agent. The CLI imports the agent defined there.`,
    'Each new launch imports the code again; there is no separate configuration snapshot.',
    'Packaged tools, skills, plugins, subagents, MCP servers, and policies live under `agent/`.',
    'The harness library is a normal dependency installed from the registry; `.agent/` holds generated sessions and memory.',
    '',
    'For a local MCP server, list its helper files and data in `files` so export can include them.',
    '`files` paths are relative to the saved configuration directory and are removed from exported SDK options.',
    'Use environment placeholders for paths and credentials supplied by the receiving machine.',
    '',
    'To use the agent in another application, install its dependencies, configure the environment,',
    'and import it from your application entrypoint:',
    '',
    python ? '```python' : '```typescript',
    python ? 'from agent.agent import agent' : "import { agent } from './dist/agent/agent.js'",
    python ? 'result = agent("Hello")' : 'const result = await agent.invoke("Hello")',
    '```',
    '',
    ...(python ? [] : ['Run `npm run build` to compile TypeScript for deployment.', '']),
  ].join('\n')
}

function portableSkillSources(paths: readonly string[], hasLocalSkills: boolean): string[] {
  const sources: string[] = []
  let includedLocalSkills = false
  for (const path of paths) {
    if (path.startsWith('https://')) {
      if (!sources.includes(path)) sources.push(path)
    } else if (hasLocalSkills && !includedLocalSkills) {
      sources.push('./agent/skills')
      includedLocalSkills = true
    }
  }
  return sources
}

function discoverSkillPackages(paths: readonly string[], optionalPaths: ReadonlySet<string>): SkillPackage[] {
  const packages = new Map<string, SkillPackage>()
  for (const path of paths) {
    let details
    try {
      details = lstatSync(path)
    } catch (error) {
      if (optionalPaths.has(path) && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Configured skill source ${JSON.stringify(path)} cannot be read.`, { cause: error })
    }
    const candidates =
      details.isFile() && basename(path).toLowerCase() === 'skill.md'
        ? [dirname(path)]
        : details.isDirectory() && hasSkillFile(path)
          ? [path]
          : details.isDirectory()
            ? readdirSync(path, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(path, entry.name))
                .filter(hasSkillFile)
            : []
    if (candidates.length === 0 && !optionalPaths.has(path)) {
      throw new Error(`Configured skill source ${JSON.stringify(path)} contains no SKILL.md.`)
    }
    for (const candidate of candidates) {
      const id = basename(candidate)
      assertPortablePathComponent(id)
      const resolved = realpathSync(candidate)
      const key = id.toLowerCase()
      const existing = packages.get(key)
      if (existing && existing.path !== resolved) {
        throw new Error(
          `Two skills share the folder name ${JSON.stringify(id)} (${existing.path} and ${resolved}); rename one before export.`
        )
      }
      packages.set(key, { id, path: resolved })
    }
  }
  return [...packages.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function hasSkillFile(path: string): boolean {
  return ['SKILL.md', 'skill.md'].some((name) => regularFile(join(path, name)))
}

// The manifest scan never sees packaged file trees, so credential-shaped files get the same
// fail-explicitly treatment by name before they reach the archive.
const SECRET_FILE_PATTERN =
  /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?|.+\.(?:pem|p12|pfx|key|keystore|jks))$/iu
const SECRET_FILE_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])

function validateNoSecretFile(source: string): void {
  const name = basename(source).toLowerCase()
  if (SECRET_FILE_PATTERN.test(name) && !SECRET_FILE_TEMPLATES.has(name)) {
    throw new Error(`Export source ${JSON.stringify(source)} looks like a credential file; remove it before export.`)
  }
}

function addPath(
  zip: ZipFile,
  source: string,
  destination: string,
  addBytes: (size: number) => void,
  privatePaths: readonly string[]
): void {
  assertPortableArchivePath(destination)
  if (privatePaths.some((path) => containsPath(path, source))) {
    throw new Error('Keep exported source outside the configured session and memory directories.')
  }
  const details = lstatSync(source)
  if (details.isSymbolicLink()) {
    throw new Error('Exported packages cannot contain symbolic links.')
  }
  if (details.isDirectory()) {
    addDirectory(zip, source, destination, addBytes, new Set(privatePaths.map((path) => posixRelative(source, path))))
  } else if (details.isFile()) {
    addFile(zip, source, destination, addBytes)
  }
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

function addDirectory(
  zip: ZipFile,
  source: string,
  destination: string,
  addBytes: (size: number) => void,
  excluded: ReadonlySet<string> = new Set()
): void {
  const root = realpathSync(source)
  if (destination) {
    zip.addEmptyDirectory(destination)
  }
  const visit = (directory: string): void => {
    const names = new Set<string>()
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assertPortablePathComponent(entry.name)
      const key = entry.name.toLowerCase()
      if (names.has(key)) {
        throw new Error(`Directory ${JSON.stringify(directory)} contains names that collide on Windows.`)
      }
      names.add(key)
      const path = join(directory, entry.name)
      if (IGNORED_DIRECTORIES.has(entry.name) || excluded.has(posixRelative(root, path))) {
        continue
      }
      const details = lstatSync(path)
      if (details.isSymbolicLink()) {
        throw new Error('Exported packages cannot contain symbolic links.')
      }
      const target = [destination, posixRelative(root, path)].filter(Boolean).join('/')
      if (details.isDirectory()) {
        zip.addEmptyDirectory(target)
        visit(path)
      } else if (details.isFile()) {
        addFile(zip, path, target, addBytes)
      }
    }
  }
  visit(root)
}

function addFile(zip: ZipFile, source: string, destination: string, addBytes: (size: number) => void): void {
  const details = lstatSync(source)
  if (!details.isFile()) {
    throw new Error('Exported packages cannot contain symbolic links.')
  }
  validateNoSecretFile(source)
  addBytes(details.size)
  // Buffered, not streamed: a validation throw later in the walk abandons the zip, and an
  // already-created read stream would leak its descriptor and emit an unhandled open error.
  // The size cap bounds total memory, and addBytes enforces it before this read.
  const contents = readFileSync(source)
  validateSourceConfiguration(source, contents)
  zip.addBuffer(contents, destination, {
    compress: false,
    mtime: details.mtime,
    mode: 0o100644 | (details.mode & 0o111),
  })
}

function validateSourceConfiguration(path: string, contents: Buffer): void {
  if (basename(path) === 'requirements.txt') {
    const python = contents
      .toString()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    validateNoConfigSecrets(normalizeHarnessAgentConfig({ dependencies: { python } }))
    return
  }
  if (!path.endsWith('.json')) return
  let document: unknown
  try {
    document = JSON.parse(contents.toString().replace(/^\uFEFF/u, ''))
  } catch {
    return
  }
  if (!isRecord(document)) return
  if (basename(path) === 'mcp.json' || basename(path) === '.mcp.json' || isRecord(document.mcpServers)) {
    validateNoConfigSecrets(normalizeHarnessAgentConfig({ mcpServers: document }))
  }
  if (basename(path) === 'package.json') {
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (document[key]) {
        validateNoConfigSecrets(normalizeHarnessAgentConfig({ dependencies: { typescript: document[key] } }))
      }
    }
  }
}

function typescriptPackageRoot(): string {
  return packageRoot(createRequire(import.meta.url).resolve('@strands-agents/harness'))
}

function packageRoot(entrypoint: string): string {
  let candidate = dirname(entrypoint)
  for (;;) {
    if (regularFile(join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) {
      throw new Error(`Unable to locate the package containing ${entrypoint}.`)
    }
    candidate = parent
  }
}

// The exported project depends on the harness the CLI itself resolved: `@strands-agents/harness` on
// npm, `strands-harness` on PyPI. They release in parity from this repo, so the installed npm version
// drives both specifiers.
function harnessVersion(): string {
  const manifest = JSON.parse(readFileSync(join(typescriptPackageRoot(), 'package.json'), 'utf8')) as {
    version: string
  }
  return manifest.version
}

function harnessPythonSpecifier(): string {
  const [major, minor] = harnessVersion().split('.')
  return `~=${major}.${minor}.0`
}

async function writeProject(
  zip: ZipFile,
  destination: string,
  overwrite: boolean,
  output: AgentProjectOutput
): Promise<void> {
  const archive = await serializeZip(zip)
  if (output === 'directory') {
    await writeProjectDirectory(archive, destination)
    return
  }
  await writeFile(destination, archive, { flag: overwrite ? 'w' : 'wx' }).catch((error: unknown) => {
    throw exportWriteError(error, destination)
  })
}

function serializeZip(zip: ZipFile): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    zip.outputStream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= MAX_PROJECT_BYTES) {
        chunks.push(chunk)
      }
    })
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => {
      if (bytes > MAX_PROJECT_BYTES) {
        reject(new Error('The exported agent project exceeds 50 MB.'))
        return
      }
      resolvePromise(Buffer.concat(chunks))
    })
    zip.end()
  })
}

async function writeProjectDirectory(archive: Buffer, destination: string): Promise<void> {
  let created = false
  try {
    await mkdir(destination)
    created = true
    const files = unzipSync(archive)
    const modes = archiveExecutableModes(archive)
    for (const [name, contents] of Object.entries(files)) {
      const path = name.replace(/\/$/u, '')
      if (!path) continue
      assertPortableArchivePath(path)
      const target = join(destination, ...path.split('/'))
      if (name.endsWith('/')) {
        await mkdir(target, { recursive: true })
      } else {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, contents, { flag: 'wx', mode: 0o644 | (modes.get(name) ?? 0) })
      }
    }
  } catch (error) {
    if (created) {
      await rm(destination, { recursive: true, force: true })
    }
    throw exportWriteError(error, destination)
  }
}

function exportWriteError(error: unknown, destination: string): unknown {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
    ? new Error(`Export destination already exists: ${destination}. Choose a different path.`)
    : error
}

function assertPortableArchivePath(path: string): void {
  for (const component of path.split('/')) {
    assertPortablePathComponent(component)
  }
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'strands-agent'
  )
}
