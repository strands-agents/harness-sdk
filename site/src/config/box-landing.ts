import { siteLink } from '../util/links'

export const BOX_LANDING_TITLE = 'Strands Box | Put your agent in a box'
export const BOX_LANDING_DESCRIPTION =
  'Strands Box runs AI agents in a sandbox that limits the files, programs, websites, and credentials they can access locally or in supported cloud deployments.'

export const BOX_CORE_REPOSITORY_URL = 'https://github.com/strands-agents/box'
export const BOX_REPOSITORY_URL = BOX_CORE_REPOSITORY_URL
export const BOX_CLI_REPOSITORY_URL = 'https://github.com/strands-agents/staging-boxy'
const BOX_CLI_USER_GUIDE_URL = `${BOX_CLI_REPOSITORY_URL}/blob/main/docs/user`
const BOX_PACKS_URL = `${BOX_CLI_REPOSITORY_URL}/blob/main/resources/packs`

export const BOX_INSTALL_COMMAND = `gh api 'repos/strands-agents/staging-boxy/contents/install.sh?ref=main' \\
  -H 'Accept: application/vnd.github.raw' > install.sh &&
sh ./install.sh`
export const BOX_VERIFY_COMMAND = 'box --version'

export const BOX_LINKS = {
  quickstart: `${BOX_CLI_USER_GUIDE_URL}/getting-started.md`,
  install: `${BOX_CLI_USER_GUIDE_URL}/install.md`,
  userGuide: `${BOX_CLI_USER_GUIDE_URL}/README.md`,
  profiles: `${BOX_CLI_USER_GUIDE_URL}/profiles.md`,
  cli: `${BOX_CLI_USER_GUIDE_URL}/cli.md`,
  limitations: `${BOX_CLI_USER_GUIDE_URL}/limitations.md`,
  security: '/docs/user-guide/box/security/',
  policy: '/docs/user-guide/box/reference/policy/',
  deployment: '/docs/user-guide/box/reference/cloud-deployments/',
  configuration: `${BOX_CLI_USER_GUIDE_URL}/profiles.md`,
  credentialGuide: '/docs/user-guide/box/guides/network-and-credentials/',
  decisionLog: `${BOX_CLI_USER_GUIDE_URL}/README.md#see-what-the-box-allowed-and-denied`,
  mcp: `${BOX_CLI_USER_GUIDE_URL}/starters.md`,
  dogwood: 'https://github.com/dogwood-policy/dogwood',
  designStory: '/blog/strands-box-the-big-picture/',
} as const

export const BOX_BOUNDARY_PANELS = [
  {
    id: 'profile',
    step: '01',
    title: 'Choose what the agent can access',
    summary: 'Give the agent the project files, programs, and connected tools it needs.',
    note: '`box profile create` writes the profile. `box profile show --full <profile>` prints the complete resolved boundary before you run it.',
    filename: 'profile.toml',
    language: 'toml',
    previewCode: `packs = ["box/claude", "box/bedrock", "box/git"]
policies = ["policy.dw"]`,
    code: `packs = ["box/claude", "box/bedrock", "box/git"]
policies = ["policy.dw"]

[options]
claude.host = "bedrock"
bedrock.region = "us-east-1"
claude.import-mcp = "false"
claude.import-hooks = "false"`,
    href: BOX_LINKS.configuration,
    linkLabel: 'Set up access',
  },
  {
    id: 'policy',
    step: '02',
    title: 'Set limits on what the agent can do',
    summary: 'Allow or block commands, file changes, network requests, and tool calls while the agent runs.',
    note: 'A forbid rule wins over a broader permit. If policy is off, turn it on before applying; with no banner or for startup access changes, restart.',
    filename: 'policy.dw',
    language: 'text',
    previewCode: `@id("no_env")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "*/.env" };`,
    code: `@id("no_env")
@description("Block shell-mediated reads of .env files.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "*/.env" };

@id("docs_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "docs.example.com" && context.input.port == 443 };

@id("docs_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "docs.example.com" };`,
    href: BOX_LINKS.policy,
    linkLabel: 'Set up rules',
  },
  {
    id: 'credentials',
    step: '03',
    title: 'Keep credentials private',
    summary: 'Let the agent call approved services without seeing the real API keys or tokens.',
    note: 'Every process in one box shares its routes. Use separate profiles when workloads need separate credential boundaries.',
    filename: 'profile.toml',
    language: 'toml',
    previewCode: `[egress.github]
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"`,
    code: `[egress.github]
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"`,
    href: BOX_LINKS.credentialGuide,
    linkLabel: 'Protect credentials',
  },
] as const

export const BOX_GETTING_STARTED = [
  {
    id: 'choose',
    eyebrow: '/01',
    title: 'Choose an agent',
    description: 'Claude Code, Codex, Kiro CLI, or pi.',
    href: BOX_LINKS.quickstart,
  },
  {
    id: 'run',
    eyebrow: '/02',
    title: 'Run from your project',
    description: 'Run one command from the project you want Box to contain.',
    href: BOX_LINKS.cli,
  },
  {
    id: 'review',
    eyebrow: '/03',
    title: 'Review and refine',
    description: 'Watch denials, then tighten the profile and policy.',
    href: BOX_LINKS.decisionLog,
  },
] as const

export const BOX_AGENT_EXAMPLES = [
  {
    id: 'claude-code',
    slug: '/claude-code',
    title: 'Claude Code',
    description: 'Run Claude Code through Box.',
    command: 'box run claude',
    href: `${BOX_PACKS_URL}/claude/README.md`,
  },
  {
    id: 'codex',
    slug: '/codex',
    title: 'Codex',
    description: 'Run Codex through Box.',
    command: 'box run codex',
    href: `${BOX_PACKS_URL}/codex/README.md`,
  },
  {
    id: 'kiro',
    slug: '/kiro-cli',
    title: 'Kiro CLI',
    description: 'Run Kiro CLI through Box.',
    command: 'box run kiro',
    href: `${BOX_PACKS_URL}/kiro/README.md`,
  },
  {
    id: 'pi',
    slug: '/pi',
    title: 'pi',
    description: 'Run pi through Box.',
    command: 'box run pi',
    href: `${BOX_PACKS_URL}/pi/README.md`,
  },
] as const

export const BOX_FEATURED_AGENT_EXAMPLES = BOX_AGENT_EXAMPLES

export const BOX_CAPABILITIES_HEADLINE = 'Control what your agent can access and do.'
export const BOX_CAPABILITIES_SUMMARY =
  'Give the agent only the access it needs, check sensitive actions as they happen, and keep real credentials outside the agent.'
export const BOX_OVERVIEW_DESCRIPTION =
  'Start your coding agent through Box. It gets the project access it needs while the rest of your computer stays out of reach.'

export const BOX_CAPABILITIES = [
  {
    id: 'access',
    label: 'Access',
    title: 'Choose what it can access',
    description: 'Give the agent the project files and programs it needs. Keep everything else out of reach.',
  },
  {
    id: 'policy',
    label: 'Policy',
    title: 'Set limits on what it can do',
    description: 'Allow or block commands, file changes, network requests, and tool calls while it runs.',
  },
  {
    id: 'credentials',
    label: 'Credentials',
    title: 'Keep credentials private',
    description: 'Let the agent call approved services without seeing the real API keys or tokens.',
  },
] as const

export const BOX_EXAMPLE_BOUNDARY = [
  {
    id: 'project-read',
    action: 'Read project files',
    result: 'Allowed',
    tone: 'allowed',
  },
  {
    id: 'private-read',
    action: 'Read private files',
    result: 'Blocked',
    tone: 'blocked',
  },
  {
    id: 'credential-route',
    action: 'Connect to GitHub',
    result: 'Credential protected',
    tone: 'routed',
  },
  {
    id: 'unknown-request',
    action: 'Connect to an unknown site',
    result: 'Blocked',
    tone: 'blocked',
  },
] as const

function heading(level: number, text: string): string {
  return `${'#'.repeat(Math.min(level, 6))} ${text}`
}

function landingLink(href: string): string {
  return href.startsWith('http') ? href : siteLink(href)
}

export function buildBoxLandingMarkdown(headingLevel = 1): string {
  const root = Math.min(Math.max(Math.trunc(headingLevel), 1), 3)
  const lines = [
    heading(root, '/box'),
    '',
    BOX_OVERVIEW_DESCRIPTION,
    '',
    `- [Run Box](${landingLink(BOX_LINKS.quickstart)})`,
    `- [Install Box CLI](${landingLink(BOX_LINKS.install)})`,
    `- [View Box Core on GitHub](${BOX_CORE_REPOSITORY_URL})`,
    '',
    heading(root + 1, 'Install Box CLI'),
    '',
    'Box CLI is beta. The installer supports Apple silicon macOS 15 or later. ARM64 Linux support is experimental, and the pi starter does not run on Linux.',
    '',
    '```sh',
    BOX_INSTALL_COMMAND,
    '```',
    '',
    'Open a new terminal before verifying the install:',
    '',
    '```console',
    `$ ${BOX_VERIFY_COMMAND}`,
    '```',
    '',
    heading(root + 1, 'Run the coding agent you already use'),
    '',
    'Open a terminal in the project where you want to run the agent. The first `box run` creates a reusable profile and asks for its settings. Later runs reuse that profile.',
    '',
    ...BOX_AGENT_EXAMPLES.flatMap((example) => [
      heading(root + 2, example.title),
      '',
      example.description,
      '',
      '```sh',
      example.command,
      '```',
      '',
      `[Open the ${example.title} setup guide](${landingLink(example.href)})`,
      '',
    ]),
    heading(root + 1, 'What Box does'),
    '',
    BOX_CAPABILITIES_HEADLINE,
    '',
    BOX_CAPABILITIES_SUMMARY,
    '',
    ...BOX_CAPABILITIES.flatMap((capability) => [heading(root + 2, capability.title), '', capability.description, '']),
    heading(root + 2, 'What Box allows'),
    '',
    'Box can allow or block requests like these:',
    '',
    ...BOX_EXAMPLE_BOUNDARY.map((outcome) => `- \`${outcome.action}\`: ${outcome.result.toLowerCase()}`),
    '',
    heading(root + 1, 'How it works'),
    '',
    'Two files define the boundary.',
    '',
    'Packs describe the agent, model provider, and tools. `profile.toml` combines those packs with MCP imports and startup access. Box-created profiles start with `policy.dw`, and profiles can list additional policy files that decide mediated requests while the agent runs. The Box CLI resolves both files and writes the Box Core configuration for each run.',
    '',
    ...BOX_BOUNDARY_PANELS.slice(0, 2).flatMap((panel) => [
      heading(root + 2, panel.title),
      '',
      panel.summary,
      '',
      `\`${panel.filename}\`:`,
      '',
      `\`\`\`${panel.language}`,
      panel.code,
      '```',
      '',
      panel.note,
      '',
      `[${panel.linkLabel}](${landingLink(panel.href)})`,
      '',
    ]),
    heading(root + 2, 'Enforced outside the agent'),
    '',
    'Operating system isolation fixes direct access before the agent starts and applies to the code it launches. Dogwood policy runs outside the sandbox to decide mediated shell, file, network, and MCP requests. The coding agent’s own approval mode does not change these controls.',
    '',
    'For routed credentials, the agent receives a stand-in. The gateway adds the real value only after policy permits a matching request. Box does not hide credentials stored in files the agent can read.',
    '',
    'Box records mediated policy decisions with the requested action, resource, result, and reason. Direct operating-system grants remain separate from that decision history.',
    '',
    `- [Read about Dogwood](${landingLink(BOX_LINKS.dogwood)})`,
    `- [Configure routed credentials](${landingLink(BOX_LINKS.credentialGuide)})`,
    `- [Understand the security model](${landingLink(BOX_LINKS.security)})`,
    `- [Read the Box design story](${landingLink(BOX_LINKS.designStory)})`,
    '',
    heading(root + 2, BOX_BOUNDARY_PANELS[2].title),
    '',
    BOX_BOUNDARY_PANELS[2].summary,
    '',
    `\`${BOX_BOUNDARY_PANELS[2].filename}\`:`,
    '',
    `\`\`\`${BOX_BOUNDARY_PANELS[2].language}`,
    BOX_BOUNDARY_PANELS[2].code,
    '```',
    '',
    BOX_BOUNDARY_PANELS[2].note,
    '',
    `[${BOX_BOUNDARY_PANELS[2].linkLabel}](${landingLink(BOX_BOUNDARY_PANELS[2].href)})`,
    '',
    heading(root + 1, 'Deploy with Box Core'),
    '',
    'Use Box CLI to run supported coding agents locally. Box Core is in preview and supports embedded workloads and documented ARM64 deployment environments.',
    '',
    `[Read the Box Core deployment guide](${landingLink(BOX_LINKS.deployment)})`,
    '',
    heading(root + 1, 'Inspect and refine the boundary'),
    '',
    'Expand the activity banner with `Ctrl+]` to watch denials. With the banner active and policy on, save a policy-only edit and press `Ctrl+Alt+R` to apply the pending update. With `--no-banner`, restart instead. After the run, use `box runs history <box-id> --deny` to inspect saved decisions.',
    '',
    `- [Read decision records](${landingLink(BOX_LINKS.decisionLog)})`,
    `- [Understand the security model](${landingLink(BOX_LINKS.security)})`,
    `- [Configure profiles and MCP imports](${landingLink(BOX_LINKS.mcp)})`,
    `- [Read the Box design story](${landingLink(BOX_LINKS.designStory)})`,
    '',
  ]

  return lines.join('\n')
}
