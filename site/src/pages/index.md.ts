import type { APIRoute } from 'astro'
import { siteLink } from '@util/links'

export const GET: APIRoute = () => {
  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is an open source framework for building production AI agents in Python and TypeScript. Start with Strands harness, then add focused tools when you need them.',
    '',
    '## Start here',
    '',
    `- [Harness quickstart](${siteLink('/docs/user-guide/harness/quickstart/index.md')}): The recommended path to a fully assembled agent.`,
    `- [Build with AI coding agents](${siteLink('/docs/user-guide/build-with-ai/index.md')}): Install the Strands plugin for Claude Code, Codex, or Cursor.`,
    `- [Examples](${siteLink('/examples/')}): Explore complete agent examples.`,
    `- [Frequently asked questions](${siteLink('/faq/index.md')}): Get practical answers about choosing, building, evaluating, and deploying with Strands.`,
    '',
    '## Focused tools',
    '',
    `- [Strands Box](${siteLink('/docs/user-guide/box/quickstart/index.md')}): Isolate the agent and set policy for the resources it can reach.`,
    `- [Strands Decider](${siteLink('/docs/labs/strands-decider/overview/index.md')}): Classify and route work with yes/no, choice, and score answers plus calibrated confidence.`,
    `- [Strands Evals](${siteLink('/docs/user-guide/evals-sdk/index.md')}): Evaluate outputs and trajectories, diagnose failures, and simulate users and tools.`,
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
