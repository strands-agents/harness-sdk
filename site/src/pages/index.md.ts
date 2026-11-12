import type { APIRoute } from 'astro'
import { getSiteOrigin, siteLink } from '@util/links'
import { homepageProductGroups } from '../config/navbar'
import { homepageTools } from '../config/homepage'

function markdownPageLink(href: string): string {
  return `${getSiteOrigin()}${href}index.md`
}

export const GET: APIRoute = () => {
  const sdkQuickstart = homepageProductGroups.foundation.sdk.pages?.find((page) => page.label === 'Quickstart')
  if (!sdkQuickstart) throw new Error('Missing Harness SDK quickstart')

  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is an open source framework for building production AI agents in Python and TypeScript. Start with Strands harness, then add focused tools when you need them.',
    '',
    '## Start here',
    '',
    `- [Harness quickstart](${siteLink('/docs/user-guide/harness/quickstart/index.md')}): The recommended path to a fully assembled agent.`,
    `- [SDK quickstart](${markdownPageLink(sdkQuickstart.href)}): Build an agent harness from the ground up with composable primitives.`,
    `- [Build with AI coding agents](${siteLink('/docs/user-guide/build-with-ai/index.md')}): Install the Strands plugin for Claude Code, Codex, or Cursor.`,
    `- [Examples](${siteLink('/examples/')}): Explore complete agent examples.`,
    `- [Frequently asked questions](${siteLink('/faq/index.md')}): Get practical answers about choosing, building, evaluating, and deploying with Strands.`,
    '',
    '## Focused tools',
    '',
    ...homepageTools.map(
      (tool) => `- [${tool.product.name}](${markdownPageLink(tool.product.href)}): ${tool.description}`
    ),
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
