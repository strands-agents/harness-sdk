import type { APIRoute } from 'astro'
import { BOX_LANDING_DESCRIPTION } from '../config/box-landing'
import { DECIDER_LANDING_DESCRIPTION } from '../config/decider-landing'
import { siteLink } from '@util/links'

export const GET: APIRoute = () => {
  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is the open source toolkit for building production AI agents in Python and TypeScript. It runs in your process with no hosted Strands control plane.',
    '',
    '## Start here',
    '',
    `- [Documentation](${siteLink('/docs/user-guide/sdk/quickstart/overview/index.md')}): Choose a model provider and build your first agent.`,
    `- [Harness quickstart](${siteLink('/docs/user-guide/harness/quickstart/index.md')}): Start with a fully assembled agent.`,
    `- [Strands Box](${siteLink('/box/index.md')}): ${BOX_LANDING_DESCRIPTION}`,
    `- [Strands Decider](${siteLink('/decider/index.md')}): ${DECIDER_LANDING_DESCRIPTION}`,
    `- [Build with AI coding agents](${siteLink('/docs/user-guide/build-with-ai/index.md')}): Install the Strands plugin for Claude Code, Codex, or Cursor.`,
    `- [Examples](${siteLink('/examples/')}): Explore complete agent examples.`,
    `- [Frequently asked questions](${siteLink('/faq/index.md')}): Get practical answers about choosing, building, evaluating, and deploying with Strands.`,
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
    `- [OpenAPI description](${siteLink('/openapi.json')})`,
    `- [Integrations catalog](${siteLink('/integrations.json')})`,
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
