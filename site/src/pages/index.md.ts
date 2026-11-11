import type { APIRoute } from 'astro'
import { siteLink } from '@util/links'

export const GET: APIRoute = () => {
  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is an open source framework and toolkit for building production AI agents in Python and TypeScript. Start with a complete harness, compose your own agent loop with SDK primitives, or add focused tools to an existing stack.',
    '',
    '## Start here',
    '',
    `- [Harness quickstart](${siteLink('/docs/user-guide/harness/quickstart/index.md')}): Start with a fully assembled agent.`,
    `- [SDK quickstart](${siteLink('/docs/user-guide/sdk/quickstart/overview/index.md')}): Compose an agent loop from Python or TypeScript primitives.`,
    `- [Build with AI coding agents](${siteLink('/docs/user-guide/build-with-ai/index.md')}): Install the Strands plugin for Claude Code, Codex, or Cursor.`,
    `- [Examples](${siteLink('/examples/')}): Explore complete agent examples.`,
    '',
    '## Focused tools',
    '',
    `- [Context management](${siteLink('/docs/user-guide/sdk/context-management/index.md')}): Keep long-running agents within the model context window.`,
    `- [Strands Decider](${siteLink('/docs/labs/strands-decider/inference/index.md')}): Make focused choices and ratings with calibrated confidence.`,
    `- [Strands Shell](${siteLink('/docs/user-guide/shell/index.md')}): Give agents a constrained, in-process shell.`,
    `- [Strands Box](${siteLink('/docs/user-guide/box/index.md')}): Contain an agent with operating-system enforcement and policy.`,
    `- [Strands Evals](${siteLink('/docs/user-guide/evals-sdk/index.md')}): Score behavior, diagnose failures, and simulate users and tools.`,
    '',
    '## Official packages',
    '',
    '- [Python harness](https://pypi.org/project/strands-harness/)',
    '- [TypeScript harness](https://www.npmjs.com/package/@strands-agents/harness)',
    '- [Python SDK](https://pypi.org/project/strands-agents/)',
    '- [TypeScript SDK](https://www.npmjs.com/package/@strands-agents/sdk)',
    '- [Strands CLI](https://www.npmjs.com/package/@strands-agents/cli)',
    '- [MCP server](https://pypi.org/project/strands-agents-mcp-server/)',
    '',
    '## Source and machine-readable docs',
    '',
    '- [GitHub repository](https://github.com/strands-agents/harness-sdk)',
    '- [Samples](https://github.com/strands-agents/samples)',
    `- [Documentation index for language models](${siteLink('/llms.txt')})`,
    `- [Complete documentation corpus](${siteLink('/llms-full.txt')})`,
    '',
  ]

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}
