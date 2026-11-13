import { siteLink } from '../util/links'

export type FaqCategoryId = 'choose' | 'build' | 'run'

export interface FaqLink {
  kind: 'link'
  text: string
  href: string
}

export interface FaqCode {
  kind: 'code'
  text: string
}

export type FaqInline = string | FaqLink | FaqCode

export interface FaqParagraph {
  kind: 'paragraph'
  content: FaqInline[]
}

export interface FaqList {
  kind: 'list'
  items: FaqInline[][]
}

export type FaqBlock = FaqParagraph | FaqList

export interface FaqItem {
  id: string
  category: FaqCategoryId
  question: string
  answer: FaqBlock[]
  featuredSummary?: string
}

export const FAQ_TITLE = 'Frequently asked questions'
export const FAQ_DESCRIPTION =
  'Answers to common questions about choosing, building, evaluating, deploying, and securing Strands agents.'
export const FAQ_INTRO =
  'Find practical answers about choosing a starting point, building and evaluating an agent, and preparing it for production.'

export const faqCategories: ReadonlyArray<{ id: FaqCategoryId; label: string }> = [
  { id: 'choose', label: 'Choose your starting point' },
  { id: 'build', label: 'Build the agent' },
  { id: 'run', label: 'Run in production' },
]

const link = (text: string, href: string): FaqLink => ({ kind: 'link', text, href })
const code = (text: string): FaqCode => ({ kind: 'code', text })
const paragraph = (...content: FaqInline[]): FaqParagraph => ({ kind: 'paragraph', content })
const list = (...items: FaqInline[][]): FaqList => ({ kind: 'list', items })

export const faqItems: FaqItem[] = [
  {
    id: 'what-is-strands',
    category: 'choose',
    question: 'What is Strands?',
    featuredSummary:
      'Strands is an open-source toolkit for building, running, and improving AI agents. Harness provides a complete agent, and the Harness SDK gives direct control. Other Strands projects work independently or together.',
    answer: [
      paragraph(
        'Strands is an open-source toolkit for building, running, and improving AI agents in Python and TypeScript. Its projects cover the agent loop, tools, session management, memory, multi-agent patterns, evaluation, isolated execution, and focused decisions.'
      ),
      paragraph(
        'Use ',
        link('Strands harness', '/docs/user-guide/harness/'),
        ' for a complete agent with tuned defaults, or use the ',
        link('Harness SDK', '/docs/user-guide/sdk/quickstart/overview/'),
        ' to choose and wire the components yourself. Add ',
        link('Box', '/docs/user-guide/box/quickstart/'),
        ', ',
        link('Shell', '/docs/user-guide/shell/'),
        ', ',
        link('Evals', '/docs/user-guide/evals-sdk/'),
        ', or ',
        link('Decider', '/docs/labs/strands-decider/overview/'),
        ' when your application needs them.'
      ),
    ],
  },
  {
    id: 'harness-or-sdk',
    category: 'choose',
    question: 'Should I use Harness or the Harness SDK?',
    featuredSummary:
      'Use Harness for a complete agent with tuned defaults for tools, context management, session management, memory, and the system prompt. Use the Harness SDK when you want to choose and wire those components yourself.',
    answer: [
      paragraph(
        link('Strands harness', '/docs/user-guide/harness/'),
        ' gives you a complete agent harness with opinionated defaults that you can override. The Strands Harness SDK gives you the agent loop and the individual components for building a harness, including tools, memory, sessions, plugins, and interventions.'
      ),
      paragraph(
        'Use Strands harness when its defaults fit your application. Use the SDK when you want to choose the components or control orchestration yourself. Strands harness is built on the SDK, so you can ',
        link('replace individual components later', '/docs/user-guide/harness/composing-with-sdk/'),
        '.'
      ),
    ],
  },
  {
    id: 'customize-harness',
    category: 'choose',
    question: 'Can I customize Harness without starting over?',
    featuredSummary:
      'Yes. Replace individual Harness defaults with Harness SDK components as your needs grow, without rebuilding the parts that already work.',
    answer: [
      paragraph(
        'Replace individual Harness defaults for tools, context management, session management, memory, or the system prompt with Harness SDK components. The rest of the assembled agent stays in place.'
      ),
      paragraph(
        'The ',
        link('composing with the Harness SDK guide', '/docs/user-guide/harness/composing-with-sdk/'),
        ' shows how to override one component at a time as your application grows.'
      ),
    ],
  },
  {
    id: 'strands-projects-fit',
    category: 'choose',
    question: 'How do Box, Shell, Evals, and Decider fit?',
    featuredSummary:
      'They are optional projects: Box isolates agent work, Shell mediates command and resource access, Evals measures agent behavior, and Decider handles routing, classification, and scoring.',
    answer: [
      list(
        [link('Box', '/docs/user-guide/box/quickstart/'), ' runs agent work in OS-isolated sandboxes.'],
        [link('Shell', '/docs/user-guide/shell/'), ' mediates command, filesystem, network, and credential access.'],
        [link('Evals', '/docs/user-guide/evals-sdk/'), ' measures agent output and behavior across repeatable cases.'],
        [
          link('Decider', '/docs/labs/strands-decider/overview/'),
          ' routes, classifies, or scores known outcomes with confidence.',
        ]
      ),
      paragraph('Add only the projects your application needs. Each works alongside Harness and the Harness SDK.'),
    ],
  },
  {
    id: 'keep-current-model',
    category: 'choose',
    question: 'Can I keep my current model when I move to Strands?',
    answer: [
      paragraph(
        'You can keep the model when its provider supports the capabilities your agent needs. The agent loop is separate from the ',
        link('model provider', '/docs/user-guide/sdk/model-providers/'),
        ', so you can change providers without restructuring the agent. For example, an application moving from OpenAI can keep its OpenAI model and credentials while using Strands for orchestration.'
      ),
      paragraph(
        'You still need to adapt tool definitions, state handling, and multi-agent behavior to the Strands APIs. The ',
        link('OpenAI migration guide', '/docs/user-guide/migrate/openai/'),
        ' maps those concepts and explains where the behavior does not translate directly.'
      ),
    ],
  },
  {
    id: 'python-or-typescript',
    category: 'choose',
    question: 'Should I use Python or TypeScript?',
    answer: [
      paragraph(
        "Use the SDK that matches your application's runtime. Both implement the core agent loop and support tools, MCP tools, streaming, structured output, sessions, and the main multi-agent patterns."
      ),
      paragraph(
        'Support for features and providers varies between the SDKs. Bidirectional agents are currently Python-only, for example. Start with the ',
        link('Python quickstart', '/docs/user-guide/sdk/quickstart/python/'),
        ' or ',
        link('TypeScript quickstart', '/docs/user-guide/sdk/quickstart/typescript/'),
        ', then check the language tabs and provider pages for the feature you need.'
      ),
    ],
  },
  {
    id: 'bidirectional-or-standard-streaming',
    category: 'choose',
    question: 'When should I use bidirectional streaming instead of standard streaming?',
    answer: [
      paragraph(
        'Standard ',
        link('streaming', '/docs/user-guide/sdk/streaming/async-iterators/'),
        ' emits events as one agent invocation produces its response. Both SDKs support async iteration, and Python also supports callback handlers.'
      ),
      paragraph(
        link('Bidirectional agents', '/docs/user-guide/sdk/bidi/'),
        ' keep a live, full-duplex session open. They can accept new text or audio while the model is still responding. Use them for interruptible voice and other real-time interactions. The ',
        link('Bidi model adapters', '/docs/user-guide/sdk/bidi/models/'),
        ' list the current provider support.'
      ),
    ],
  },
  {
    id: 'strands-labs-projects',
    category: 'choose',
    question: 'When should I use a Strands Labs project?',
    answer: [
      paragraph(
        link('Strands Labs', '/docs/labs/'),
        ' houses experimental projects that extend the SDK into robotics, world models, agentic benchmarks, harness optimization, audio processing, and decision models. Each project lives in its own open source repository in the ',
        link('Strands Labs GitHub organization', 'https://github.com/strands-labs'),
        ' and works alongside the SDK.'
      ),
      paragraph(
        'Labs projects change faster than the core SDK. Check each project for its current setup, support, and maturity before using it in production. A project may graduate, become a standalone product, or remain experimental.'
      ),
    ],
  },
  {
    id: 'simulated-or-physical-robots',
    category: 'choose',
    question: 'Can Strands control simulated and physical robots?',
    answer: [
      paragraph(
        link('Strands Robots', 'https://github.com/strands-labs/robots'),
        ' is an experimental Python library with one interface for simulation and supported hardware. An agent can select robot capabilities through tools, while the robot runtime applies motion and safety controls.'
      ),
      paragraph(
        'Start in simulation before connecting physical hardware. A deployed robot still needs tested limits, an emergency stop, and supervision appropriate to the task.'
      ),
    ],
  },
  {
    id: 'strands-for-cosmos',
    category: 'choose',
    question: 'What can Strands for Cosmos add to an agent?',
    answer: [
      paragraph(
        link('Strands for Cosmos', 'https://github.com/strands-labs/strands-for-cosmos'),
        ' is an experimental Python model provider integration for NVIDIA Cosmos. It lets an agent reason over images and video and use project tools for media or robot-action workflows on local NVIDIA compute.'
      ),
      paragraph(
        'Choose it for physical-world or multimodal work that needs Cosmos models. Check the project requirements first because model choice, GPU memory, and runtime setup differ by task.'
      ),
    ],
  },
  {
    id: 'benchmark-harnesses-or-evals',
    category: 'choose',
    question: 'Should I use Benchmark Harnesses or the Strands Evals SDK?',
    answer: [
      paragraph(
        'Use ',
        link('Benchmark Harnesses', 'https://github.com/strands-labs/benchmark-harnesses'),
        ' to reproduce or modify a complete agent and environment for a public benchmark. Each project includes its runner, tools, configuration, and task environment.'
      ),
      paragraph(
        'Use the ',
        link('Strands Evals SDK', '/docs/user-guide/evals-sdk/'),
        ' to measure your own agent with repeatable cases and evaluators, diagnose failures, and compare reports across runs.'
      ),
    ],
  },
  {
    id: 'ai-functions-or-regular-code',
    category: 'choose',
    question: 'When should I use AI Functions instead of regular Python code?',
    answer: [
      paragraph(
        'Use ',
        link('AI Functions', 'https://github.com/strands-labs/ai-functions'),
        ' when a task is hard to implement deterministically but you can validate the result. A typed Python function and its docstring define the task. Post-conditions check each result and return validation errors to the model for another attempt, up to the configured limit.'
      ),
      paragraph(
        'Write regular Python when the logic is straightforward and deterministic. AI Functions is a Strands Labs project. Code execution stays off by default, and its local execution mode is not a sandbox.'
      ),
    ],
  },
  {
    id: 'custom-or-mcp-tool',
    category: 'build',
    question: 'Should I build a custom tool or use an MCP tool?',
    answer: [
      paragraph(
        'Use a ',
        link('custom tool', '/docs/user-guide/sdk/tools/custom-tools/'),
        ' for application code registered directly with an agent. Use an ',
        link('MCP tool', '/docs/user-guide/sdk/tools/mcp-tools/'),
        ' when the tool is discovered and called through an MCP server. An agent can use both types together.'
      ),
      paragraph(
        'When one model response requests several tools, both SDKs run them concurrently by default. Choose a ',
        link('sequential executor', '/docs/user-guide/sdk/tools/executors/'),
        ' when order matters or the tools share mutable state that is not safe to access concurrently.'
      ),
    ],
  },
  {
    id: 'multi-agent-pattern',
    category: 'build',
    question: 'Which multi-agent pattern fits my application?',
    answer: [
      paragraph('The right pattern depends on who should control the execution path:'),
      list(
        ['Agents as tools keep one coordinator in control while it calls specialists.'],
        ['Agent-to-Agent (A2A) lets independently deployed agents communicate across service boundaries.'],
        ['A graph lets you define allowed nodes and edges, including branches and loops.'],
        ['In a swarm, agents choose which peer receives the next handoff.'],
        ['A workflow puts a fixed dependency graph in code for repeatable work.']
      ),
      paragraph(
        'The ',
        link('multi-agent patterns', '/docs/user-guide/sdk/multi-agent/multi-agent-patterns/'),
        ' guide compares examples and tradeoffs.'
      ),
    ],
  },
  {
    id: 'sessions-memory-context',
    category: 'build',
    question: 'How do sessions, memory, and context management work together?',
    answer: [
      paragraph(
        link('Session management', '/docs/user-guide/sdk/agents/session-management/'),
        ' persists conversation and agent state so your application can resume work later. ',
        link('Long-term memory', '/docs/user-guide/sdk/memory/overview/'),
        ' stores selected knowledge for recall across sessions without replaying the full conversation. ',
        link('Context management', '/docs/user-guide/sdk/context-management/'),
        ' decides what stays in the active model context as the conversation continues.'
      ),
    ],
  },
  {
    id: 'automatic-or-agentic-context',
    category: 'build',
    question: 'Should I use automatic or agentic context management?',
    answer: [
      paragraph('Both modes use the experimental Context Manager strategy API, which may change in future versions.'),
      paragraph(
        link('Automatic mode', '/docs/user-guide/sdk/context-management/built-in-modes/'),
        ' uses SDK-defined thresholds and actions to offload, truncate, or summarize context. A summary can be model-written; the SDK still decides when the strategy runs.'
      ),
      paragraph(
        link('Agentic mode', '/docs/user-guide/sdk/context-management/built-in-modes/#agentic-context-management'),
        ' gives the model context-usage information and tools so it can decide when and what to compress or protect. That flexibility requires additional model work.'
      ),
    ],
  },
  {
    id: 'structured-output-validation',
    category: 'build',
    question: 'What happens when structured output fails validation?',
    answer: [
      paragraph(
        link('Structured output', '/docs/user-guide/sdk/agents/structured-output-behavior/#forced-tool-call'),
        ' presents your schema to the model as a tool. Strands validates the tool input and returns any errors to the model so it can correct the result.'
      ),
      paragraph(
        'If the model still does not return valid structured output after the forced retry, the call raises ',
        code('StructuredOutputException'),
        ' in Python or ',
        code('StructuredOutputError'),
        ' in TypeScript.'
      ),
      paragraph(
        'To keep retrying and cap the total number of failures, set ',
        code("limits['structured_output_attempts']"),
        ' in Python or ',
        code('limits.structuredOutputAttempts'),
        ' in TypeScript on the call. When the ',
        link('attempt limit', '/docs/user-guide/sdk/agents/structured-output-behavior/#limit-attempts'),
        ' is reached, the result has the stop reason ',
        code('limit_structured_output_attempts'),
        ' in Python or ',
        code('limitStructuredOutputAttempts'),
        ' in TypeScript, with no structured output.'
      ),
    ],
  },
  {
    id: 'hooks-plugins-middleware-interventions',
    category: 'build',
    question: 'When should I use hooks, plugins, middleware, or interventions?',
    answer: [
      list(
        [link('Hooks', '/docs/user-guide/sdk/agents/hooks/'), ' respond to lifecycle events on an agent.'],
        [link('Plugins', '/docs/user-guide/sdk/plugins/'), ' package reusable behavior and attach it to agents.'],
        [link('Middleware', '/docs/user-guide/sdk/agents/middleware/'), ' wraps model or tool execution.'],
        [
          link('Interventions', '/docs/user-guide/sdk/agents/interventions/'),
          ' inspect an action and can allow, modify, reject, or pause it.',
        ]
      ),
    ],
  },
  {
    id: 'agent-configuration',
    category: 'build',
    question: 'When should I define an agent in configuration instead of code?',
    answer: [
      paragraph(
        'Use the experimental ',
        link('Agent Configuration', '/docs/user-guide/sdk/experimental/agent-config/'),
        ' API when the agent name, Amazon Bedrock model ID, system prompt, and tools that can be declared in configuration fit in a JSON file or Python dictionary. ',
        code('config_to_agent'),
        ' returns an ',
        code('Agent'),
        ', and constructor arguments override values from the configuration.'
      ),
      paragraph(
        'Build the agent in code when a tool needs constructor arguments or another live object. Agent Configuration is available in the Python SDK and remains experimental.'
      ),
    ],
  },
  {
    id: 'harness-optimizer',
    category: 'build',
    question: 'When should I use Harness Optimizer?',
    answer: [
      paragraph(
        'Use ',
        link('Harness Optimizer', 'https://github.com/strands-labs/harness-optimizer'),
        ' after you have repeatable tasks and a reward signal. It represents parts of an agent harness, such as the system prompt, tool descriptions, or agent skills, as tunable ',
        code('Formula'),
        ' objects. Rollout engines run the tasks, reward functions score the trajectories, and optimizers update the ',
        code('Formula'),
        ' objects.'
      ),
      paragraph(
        'Test each update against cases the optimizer did not use. This catches changes that improve the training rollouts without improving the agent more generally.'
      ),
    ],
  },
  {
    id: 'voice-agent-speaker-echo',
    category: 'build',
    question: 'How do I stop a voice agent from hearing its own speaker output?',
    answer: [
      paragraph(
        'In a Python Bidi agent, use a headset or enable ',
        link('audio processing', '/docs/user-guide/sdk/bidi/io/#audio-processing'),
        ' in the same ',
        code('AudioIO'),
        ' instance that handles microphone input and speaker output. Install the ',
        code('bidi-aec'),
        ' extra and set ',
        code('audio_processor=True'),
        '. Strands then applies echo cancellation, noise suppression, and automatic gain control.'
      ),
      paragraph(
        'Audio processing requires mono microphone input, and echo cancellation also requires mono playback. With a headset, use ',
        code('AudioProcessorConfig'),
        ' to turn off echo cancellation while keeping noise suppression and gain control.'
      ),
    ],
  },
  {
    id: 'approval-for-risky-tools',
    category: 'run',
    question: 'How do I require approval for risky tool calls?',
    answer: [
      paragraph(
        'Use ',
        link('Human in the Loop', '/docs/user-guide/sdk/agents/approve-before-acting/'),
        ' to pause selected tool calls until a person approves or rejects them. Its optional model-based risk classifier can reduce unnecessary prompts. The classifier is still a model judgment, so it does not replace authorization.'
      ),
      paragraph(
        'If every call to a tool must prompt, negate its name with ',
        code('allowed_tools=["!delete_files"]'),
        ' in Python or ',
        code("allowedTools: ['!delete_files']"),
        ' in TypeScript. A negated tool always prompts and cannot be trusted. For permissions that approval must never override, add ',
        link('Cedar Authorization', '/docs/user-guide/sdk/agents/interventions/cedar-authorization/'),
        ' before Human in the Loop.'
      ),
    ],
  },
  {
    id: 'retries-or-invocation-limits',
    category: 'run',
    question: 'When should I use retries or invocation limits?',
    answer: [
      paragraph(
        'Use ',
        link('retry strategies', '/docs/user-guide/sdk/agents/retry-strategies/'),
        ' to recover individual model calls from transient provider failures. Retry conditions, backoff, and defaults differ between SDKs and providers, so configure them for your runtime.'
      ),
      paragraph(
        'Use ',
        link('production lifecycle controls', '/docs/user-guide/sdk/agents/lifecycle-controls/'),
        ' to bound the complete agent invocation. They cap turns, tokens, or failed structured-output attempts, support cancellation, and return a stop reason that your application can handle.'
      ),
    ],
  },
  {
    id: 'evaluate-before-production',
    category: 'run',
    question: 'How do I evaluate a Strands agent before production?',
    answer: [
      paragraph(
        'Use ',
        link('Strands Evals', '/docs/user-guide/evals-sdk/'),
        " to run repeatable cases and score an agent's output, trajectory, or interactions. An experiment combines cases, a task that runs the agent, and one or more evaluators. It returns scores and pass or fail results."
      ),
      paragraph(
        'Start with output checks, then add trace-based evaluators for tool use or multi-turn behavior. Simulators create user and tool interactions, red teaming probes unsafe behavior, and detectors diagnose failed runs. The ',
        link('evaluation guide', '/docs/user-guide/evals-sdk/how-evaluation-works/'),
        ' explains how these pieces fit together.'
      ),
    ],
  },
  {
    id: 'deploy-strands-agent',
    category: 'run',
    question: 'Where can I run a Strands agent?',
    featuredSummary:
      'Strands runs inside your application process. Deploy that application to serverless, containers, Kubernetes, or a managed agent runtime.',
    answer: [
      paragraph(
        'Strands agents run in your application process. Deploy the application behind the entry point required by the target environment. The ',
        link('deployment guides', '/docs/user-guide/sdk/deploy/'),
        ' cover serverless, container, Kubernetes, and managed agent-runtime options.'
      ),
      paragraph(
        'Pick a target based on latency, streaming, state, network access, scaling, and isolation requirements. Keeping environment details outside the agent lets the same code move between targets.'
      ),
    ],
  },
  {
    id: 'strands-shell-isolation',
    category: 'run',
    question: 'When should I use Strands Shell?',
    answer: [
      paragraph(
        'Use ',
        link('Strands Shell', '/docs/user-guide/shell/'),
        ' when an agent needs a fast command line with controlled access to files, network destinations, and credentials. It runs inside your application as a Python or Node.js library, or as an MCP server. Only bound host paths are exposed, and configured credentials are injected for matching requests. Public HTTP(S) URLs remain reachable under the default SSRF guard; use ',
        code('allowed_urls'),
        ' to permit specific internal destinations.'
      ),
      paragraph(
        'Strands Shell provides in-process mediation. Run it inside a container or microVM when untrusted tenants can execute adversarial code. The ',
        link('security model', '/docs/user-guide/shell/security/'),
        ' explains the boundary and configuration choices.'
      ),
    ],
  },
  {
    id: 'production-observability',
    category: 'run',
    question: 'How do I observe a Strands agent in production?',
    answer: [
      paragraph(
        'The SDK emits ',
        link('OpenTelemetry traces and metrics', '/docs/user-guide/sdk/observability-evaluation/observability/'),
        " and works with your application's logging. Configure trace and metric exporters or a collector, along with your logging handlers. Monitor model calls, tool calls, latency, token use, errors, and application outcomes."
      ),
      paragraph(
        'Telemetry can contain prompts, messages, and tool input or output. Handle it as sensitive data: limit access and retention, collect only what you need, and ',
        link('redact personal data', '/docs/user-guide/sdk/safety-security/pii-redaction/'),
        '.'
      ),
    ],
  },
  {
    id: 'production-security',
    category: 'run',
    question: 'Which security controls do I need in production?',
    answer: [
      paragraph(
        'No single SDK setting secures an agent. System prompts can steer behavior, but they do not enforce policy. Give tools the least privilege they need, enforce deterministic authorization, and add interventions, validation, guardrails, trusted history, and telemetry controls. See ',
        link('Secure for production', '/docs/user-guide/sdk/safety-security/'),
        '.'
      ),
      paragraph(
        'In Python and TypeScript on Node.js, omitting the ',
        code('sandbox'),
        ' setting makes command and file tools use the host process permissions. Configure a ',
        link('Docker or SSH sandbox', '/docs/user-guide/sdk/sandbox/'),
        ', or a custom backend with the guarantees you need. The sandbox interface routes operations, while the backend and its environment determine the actual isolation boundary.'
      ),
    ],
  },
]

export const featuredFaqItems = faqItems.filter(
  (item): item is FaqItem & { featuredSummary: string } => item.featuredSummary !== undefined
)

export function faqInlineText(content: FaqInline[]): string {
  return content.map((part) => (typeof part === 'string' ? part : part.text)).join('')
}

export function faqAnswerText(blocks: FaqBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === 'paragraph'
        ? faqInlineText(block.content)
        : block.items.map((item) => faqInlineText(item)).join(' ')
    )
    .join('\n\n')
}

export function isExternalFaqHref(href: string): boolean {
  return href.startsWith('https://') || href.startsWith('http://')
}

export function faqMarkdownHref(href: string): string {
  if (isExternalFaqHref(href)) return href

  const hashIndex = href.indexOf('#')
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  return `${path.replace(/\/$/, '')}/index.md${hash}`
}

export function faqAbsoluteMarkdownHref(href: string): string {
  if (isExternalFaqHref(href)) return href
  return siteLink(faqMarkdownHref(href))
}

export function faqInlineMarkdown(content: FaqInline[], resolveLink: (href: string) => string): string {
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part.kind === 'code') return `\`${part.text}\``
      return `[${part.text}](${resolveLink(part.href)})`
    })
    .join('')
}

export function faqAnswerMarkdown(blocks: FaqBlock[], resolveLink: (href: string) => string): string {
  return blocks
    .map((block) => {
      if (block.kind === 'paragraph') return faqInlineMarkdown(block.content, resolveLink)
      return block.items.map((item) => `- ${faqInlineMarkdown(item, resolveLink)}`).join('\n')
    })
    .join('\n\n')
}
