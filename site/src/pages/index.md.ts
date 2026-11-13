import type { APIRoute } from 'astro'
import { homepageCapabilities, homepageStartProjects } from '../config/homepage'
import { siteLink } from '@util/links'

export const GET: APIRoute = () => {
  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is an open-source toolkit for building, running, and improving agents in Python and TypeScript. Harness provides a complete agent with tuned defaults for pilot through production. Use the Harness SDK for direct control of the agent loop and its components. Box provides OS-isolated execution, Evals measures agent behavior, and Decider routes, classifies, or scores known outcomes. Agents run in-process, with no hosted Strands control plane.',
    '',
    '## Build an agent',
    '',
    ...homepageStartProjects.map(
      ({ product, description, markdownHref }) => `- [${product.name}](${siteLink(markdownHref)}): ${description}`
    ),
    ...homepageCapabilities.map(
      ({ product, description, markdownHref }) => `- [${product.label}](${siteLink(markdownHref)}): ${description}`
    ),
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
