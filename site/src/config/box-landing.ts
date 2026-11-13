export const BOX_PAGE_TITLE = 'Strands Box | Run agents inside a boundary'
export const BOX_PAGE_DESCRIPTION =
  'Strands Box runs agent workloads inside operating-system boundaries and applies policy to mediated commands, file operations, network requests, and MCP calls.'

export const BOX_DOWNLOAD_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/strands-agents/box/refs/heads/main/download.sh | sh'

export const BOX_CONFIG_SNIPPET = `[agent.filesystem]
read = ["~/box-tutorial/strands-home"]
write = ["~/box-tutorial/strands-home"]
list = ["~/box-tutorial/my-project"]`

export const BOX_POLICY_SNIPPET = `@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when {
  context.input.path == "~/box-tutorial/my-project" ||
  context.input.path like "~/box-tutorial/my-project/*"
};`

export const BOX_LINKS = {
  quickstart: '/docs/user-guide/box/quickstart/',
  security: '/docs/user-guide/box/security/',
  configuration: '/docs/user-guide/box/reference/configuration/',
  policy: '/docs/user-guide/box/reference/policy/',
  decisions: '/docs/user-guide/box/guides/write-a-policy/#step-4-read-the-decision-log',
  repository: 'https://github.com/strands-agents/box',
} as const

export interface BoxExample {
  id: string
  label: string
  description: string
  filename: string
  command: string
  href: string
}

export const BOX_EXAMPLES: BoxExample[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Run Claude Code with Box policy and filesystem boundaries.',
    filename: 'run-claude-code.sh',
    command: `./box-core/box run --config claude-code/box.toml -- -p \\
  "Summarize README.md in one sentence."`,
    href: '/docs/user-guide/box/guides/run-claude-code/',
  },
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    description: 'Run Codex CLI inside a configured Box workspace.',
    filename: 'run-codex-cli.sh',
    command: `./box-core/box run --config codex/box.toml -- \\
  "Summarize README.md in one sentence."`,
    href: '/docs/user-guide/box/guides/run-codex-cli/',
  },
  {
    id: 'strands-agent',
    label: 'Strands Agent',
    description: 'Run a Strands agent behind the same OS and policy boundary.',
    filename: 'run-strands-agent.sh',
    command: `./box-core/box run --config strands-agent/box.toml -- \\
  "Summarize README.md in one sentence."`,
    href: '/docs/user-guide/box/guides/run-strands-harness/',
  },
]

function markdownLink(label: string, href: string, resolveInternalLink: (href: string) => string): string {
  const resolved = href.startsWith('http') ? href : resolveInternalLink(href)
  return `[${label}](${resolved})`
}

export function buildBoxLandingMarkdown(resolveInternalLink: (href: string) => string = (href) => href): string {
  const lines = [
    '# Strands Box',
    '',
    'Run agents. Set the boundary.',
    '',
    BOX_PAGE_DESCRIPTION,
    '',
    'Box supports Apple silicon macOS and ARM64 Linux.',
    '',
    '## Two files define the boundary',
    '',
    '### `box.toml`: Set direct access',
    '',
    'Choose the agent command, workspace, programs, environment, and readable or writable paths. The operating system applies those limits before the process starts.',
    '',
    '```toml',
    BOX_CONFIG_SNIPPET,
    '```',
    '',
    '### `policy.dw`: Decide mediated requests',
    '',
    'Permit or forbid commands, file operations, network requests, and MCP calls routed through Box. Requests without a matching permit are refused.',
    '',
    '```text',
    BOX_POLICY_SNIPPET,
    '```',
    '',
    [
      markdownLink('Configure Box', BOX_LINKS.configuration, resolveInternalLink),
      markdownLink('Write a policy', BOX_LINKS.policy, resolveInternalLink),
      markdownLink('Read the decision log', BOX_LINKS.decisions, resolveInternalLink),
      markdownLink('Security model', BOX_LINKS.security, resolveInternalLink),
    ].join(' · '),
    '',
    '## Box the agent you already use',
    '',
    'Install Box, start with a working example, then narrow the boundary for your workload.',
    '',
    '### Install',
    '',
    '```sh',
    BOX_DOWNLOAD_COMMAND,
    '```',
    '',
    '### Configure',
    '',
    'Define direct access in `box.toml` and mediated actions in `policy.dw`.',
    '',
    '### Run',
    '',
    'Launch the workload, review refused requests, and add only the permits you intend.',
    '',
    '### Run an example',
    '',
    ...BOX_EXAMPLES.flatMap((example) => [
      `#### ${example.label}`,
      '',
      example.description,
      '',
      '```sh',
      example.command,
      '```',
      '',
      markdownLink('Open the full guide', example.href, resolveInternalLink),
      '',
    ]),
    markdownLink('Run the Box quickstart', BOX_LINKS.quickstart, resolveInternalLink),
    '',
    markdownLink('View Box on GitHub', BOX_LINKS.repository, resolveInternalLink),
    '',
  ]

  return lines.join('\n')
}
