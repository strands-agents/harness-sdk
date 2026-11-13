import type { APIRoute } from 'astro'
import { siteLink } from '@util/links'

export const GET: APIRoute = () => {
  const lines = [
    '# Strands Agents',
    '',
    '> Strands Agents is an open-source framework for building, running, and improving agents in Python and TypeScript. Start with Strands harness for a complete agent. Use the Harness SDK for direct control of the agent loop and its components. Add Box for OS-isolated execution, Shell for mediated command access, Evals for evaluation, and Decider for focused decisions. Agents run in-process, with no hosted Strands control plane.',
    '',
    '## Start here',
    '',
    `- [Strands harness quickstart](${siteLink('/docs/user-guide/harness/quickstart/index.md')}): Start with a complete agent in Python or TypeScript.`,
    `- [Strands harness overview](${siteLink('/docs/user-guide/harness/index.md')}): See the defaults you get and how to customize them.`,
    `- [Harness SDK quickstart](${siteLink('/docs/user-guide/sdk/quickstart/overview/index.md')}): Choose and wire the model, tools, context management, session management, memory, and hooks.`,
    `- [Box](${siteLink('/docs/user-guide/box/index.md')}): Run agent work in OS-isolated sandboxes with explicit filesystem, network, and policy controls.`,
    `- [Shell](${siteLink('/docs/user-guide/shell/index.md')}): Give agents an in-process shell that mediates filesystem, network, and credential access.`,
    `- [Evals](${siteLink('/docs/user-guide/evals-sdk/index.md')}): Run evaluation experiments, detect failures, and measure agent resilience before deployment.`,
    `- [Decider](${siteLink('/docs/labs/strands-decider/overview/index.md')}): Route, classify, or score known outcomes with a small decision model that reports confidence.`,
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
