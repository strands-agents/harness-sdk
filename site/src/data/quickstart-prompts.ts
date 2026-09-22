/**
 * Prompts behind the "Copy prompt" button on the Python and TypeScript quickstarts.
 *
 * Each prompt is written for a coding agent (Kiro, Claude Code, Cursor, etc.) and
 * mirrors the steps on the page so the agent lands on the same first agent a human
 * reader would. It carries the exact code so the coding agent doesn't guess at
 * Strands APIs, and it asks (never assumes) before installing the Strands MCP server.
 *
 * Keep these in sync with quickstart/python.mdx, quickstart/typescript.mdx, and
 * harness/quickstart.mdx.
 */

const MCP_STEP = `
Step 4: Offer the Strands MCP server (ask first, do not install without confirmation)
Strands ships an MCP server that gives you live access to the Strands documentation while
you work, so the code you generate follows current APIs. Ask me whether I want it set up
in this coding tool. If I say yes, it requires uv (https://github.com/astral-sh/uv).
The server runs as: command "uvx", args ["strands-agents-mcp-server"]. Config locations:
  - Kiro: ~/.kiro/settings/mcp.json under "mcpServers"
  - Cursor: ~/.cursor/mcp.json under "mcpServers"
  - Claude Code: run \`claude mcp add strands uvx strands-agents-mcp-server\`
  - Codex: ~/.codex/config.toml as [mcp_servers.strands-agents]
  - VS Code: mcp.json under "servers"
If I say no, skip this step entirely.

Throughout: prefer the Strands docs at https://strandsagents.com/docs/ over memory. Use
tools from the Strands Harness SDK (vended tools) or custom tools instead of a separate community package.
`.trim()

export const PYTHON_QUICKSTART_PROMPT = `
Help me build my first agent with the Strands Harness SDK in Python. Work through these
steps in order, checking with me before anything that installs software or writes files.

Step 1: Environment
Confirm Python 3.10+ is available. Create and activate a virtual environment in the
current directory, then install the Strands Harness SDK: pip install strands-agents

Step 2: Pick a model provider and run a first agent
Ask me which model provider I want to use: Amazon Bedrock (default, needs AWS credentials
or a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK), Anthropic (ANTHROPIC_API_KEY),
OpenAI (OPENAI_API_KEY), Google (GEMINI_API_KEY), or Ollama (local, no key). Install the
matching extra if needed: strands-agents[anthropic], [openai], [gemini], or [ollama].
Then create agent.py with the snippet for my provider. The model is one object handed to
the Agent; everything else is the same across providers.

  # Amazon Bedrock (default): no model object needed
  from strands import Agent
  agent = Agent()
  agent("What is an agent harness, in one sentence?")

  # Anthropic
  from strands import Agent
  from strands.models.anthropic import AnthropicModel
  model = AnthropicModel(model_id="claude-sonnet-5", max_tokens=4096)
  agent = Agent(model=model)
  agent("What is an agent harness, in one sentence?")

  # OpenAI
  from strands import Agent
  from strands.models.openai import OpenAIModel
  model = OpenAIModel(model_id="gpt-5.4")
  agent = Agent(model=model)
  agent("What is an agent harness, in one sentence?")

  # Google
  from strands import Agent
  from strands.models.gemini import GeminiModel
  model = GeminiModel(model_id="gemini-2.5-flash")
  agent = Agent(model=model)
  agent("What is an agent harness, in one sentence?")

  # Ollama (run \`ollama serve\` and \`ollama pull llama3.1\` first)
  from strands import Agent
  from strands.models.ollama import OllamaModel
  model = OllamaModel(host="http://localhost:11434", model_id="llama3.1")
  agent = Agent(model=model)
  agent("What is an agent harness, in one sentence?")

Run it with: python -u agent.py

Step 3: Add tools to the agent
Tools come from two places: vended tools that ship with the Strands Harness SDK (strands.vended_tools) and
custom tools made with the @tool decorator. Add one of each. Put this at the top of
agent.py:

  from strands import Agent, tool
  from strands.vended_tools import file_editor

  @tool
  def letter_counter(word: str, letter: str) -> int:
      """
      Count occurrences of a specific letter in a word.

      Args:
          word (str): The input word to search in
          letter (str): The specific letter to count

      Returns:
          int: The number of occurrences of the letter in the word
      """
      if len(letter) != 1:
          raise ValueError("The 'letter' parameter must be a single character")
      return word.lower().count(letter.lower())

Then change the agent creation to pass both tools (keep the model= argument if I chose a
non-Bedrock provider) and use this prompt:

  agent = Agent(tools=[letter_counter, file_editor])
  agent('How many letter R\\'s are in the word "strawberry"? Write the answer to answer.txt.')

Run it again and confirm answer.txt was created. Explain briefly that the model routed the
counting to letter_counter and the file write to file_editor.

${MCP_STEP}
`.trim()

export const TYPESCRIPT_QUICKSTART_PROMPT = `
Help me build my first agent with the Strands Harness SDK in TypeScript. Work through
these steps in order, checking with me before anything that installs software or writes
files.

Step 1: Environment
Confirm Node.js 20+ and npm are available. In a new project directory run:
  npm init -y
  npm pkg set type=module
  npm install @strands-agents/sdk zod
  npm install --save-dev @types/node typescript

Step 2: Pick a model provider and run a first agent
Ask me which model provider I want to use: Amazon Bedrock (default, needs AWS credentials
or a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK), Anthropic (ANTHROPIC_API_KEY, npm
install @anthropic-ai/sdk), OpenAI (OPENAI_API_KEY, npm install openai), or Google
(GEMINI_API_KEY, npm install @google/genai). Then create src/agent.ts with the snippet
for my provider. The model is one object handed to the Agent; everything else is the
same across providers.

  // Amazon Bedrock (default): no model object needed
  import { Agent } from '@strands-agents/sdk'
  const agent = new Agent()
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)

  // Anthropic
  import { Agent } from '@strands-agents/sdk'
  import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
  const model = new AnthropicModel({ modelId: 'claude-sonnet-5' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)

  // OpenAI
  import { Agent } from '@strands-agents/sdk'
  import { OpenAIModel } from '@strands-agents/sdk/models/openai'
  const model = new OpenAIModel({ modelId: 'gpt-5.4' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)

  // Google
  import { Agent } from '@strands-agents/sdk'
  import { GoogleModel } from '@strands-agents/sdk/models/google'
  const model = new GoogleModel({ modelId: 'gemini-2.5-flash' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)

Run it with: npx tsx src/agent.ts

Step 3: Add tools to the agent
Tools come from two places: vended tools that ship with the Strands Harness SDK
(@strands-agents/sdk/vended-tools/*) and custom tools made with tool(). Add one of each.
Put this at the top of src/agent.ts:

  import { Agent, tool } from '@strands-agents/sdk'
  import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
  import z from 'zod'

  const letterCounter = tool({
    name: 'letter_counter',
    description:
      'Count occurrences of a specific letter in a word. Performs case-insensitive matching.',
    inputSchema: z
      .object({
        word: z.string().describe('The input word to search in'),
        letter: z.string().describe('The specific letter to count'),
      })
      .refine((data) => data.letter.length === 1, {
        message: "The 'letter' parameter must be a single character",
      }),
    callback: (input) => {
      const { word, letter } = input
      let count = 0
      for (const char of word.toLowerCase()) {
        if (char === letter.toLowerCase()) count++
      }
      return \`The letter '\${letter}' appears \${count} time(s) in '\${word}'\`
    },
  })

Then change the agent creation to pass both tools (keep the model option if I chose a
non-Bedrock provider) and use this prompt:

  const agent = new Agent({ tools: [letterCounter, fileEditor] })
  const result = await agent.invoke(
    \`How many letter R's are in the word "strawberry"? Write the answer to answer.txt.\`
  )
  console.log(result.lastMessage)

Run it again and confirm answer.txt was created. Explain briefly that the model routed the
counting to letter_counter and the file write to fileEditor.

${MCP_STEP}
`.trim()

export const HARNESS_QUICKSTART_PROMPT = `
Help me get started with Strands harness. Strands harness is a complete, pre-configured agent harness built
on the Strands Harness SDK: one call returns a ready agent with a shell, file tools, web access,
memory, and sessions already wired up. Work through these steps in order, checking with me
before anything that installs software or writes files.

Step 1: Pick a path
Ask me whether I want to (a) build an agent with the Strands CLI, no code required, or
(b) use Strands harness as a Python or TypeScript library. If I pick the CLI, do Step 2 and then
offer Step 3 as the way to turn the result into code. If I pick the library, skip to Step 3.

Step 2: Build an agent with the CLI
Install it (Node.js 20+):
  npm install -g @strands-agents/cli

Run the setup assistant:
  strands

It asks where to start (from scratch, or from a configuration it detects in the current
directory), the agent's name and goals, and which capabilities to enable (it recommends a
model, built-in tools, Agent Skills, MCP servers, long-term memory, context management, and
a tool-approval mode; I can accept its picks or adjust each one), then theme and color
mode. It keeps the configuration as a draft until I approve it, then opens the agent in a
chat. Help me answer the questions; do not answer them for me.

Fields can also be set directly instead of through the wizard:
  strands --name release-notes-bot --model anthropic/claude-sonnet-5
  strands --agent ./agent.ts          # start from an exported agent file

When I'm ready to embed the agent in an application, /export inside the chat writes a
Python or TypeScript project with my choices set on create_harness(...) / createHarness(...)
and exports a ready-to-import agent.

Step 3: Use Strands harness as a library
Ask me whether I want Python or TypeScript.
  - Python (3.10+): create and activate a virtual environment, then
      pip install strands-harness
  - TypeScript (Node.js 20+): in a new project directory run
      npm init -y
      npm pkg set type=module
      npm install @strands-agents/harness
      npm install --save-dev @types/node typescript

Then ask me which model provider I want: Amazon Bedrock (default, needs AWS credentials or
a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK), Anthropic (ANTHROPIC_API_KEY), OpenAI
(OPENAI_API_KEY), Google (GEMINI_API_KEY), or Ollama (local, no key; run \`ollama serve\`
and \`ollama pull llama3.1\` first). Strands harness picks the provider from a "provider/name"
model string. Bedrock is the default, so it needs no model argument.

Create agent.py (Python) or src/agent.ts (TypeScript) with the snippet for my choices.
The task exercises web access, file tools, and multi-step work; the agent writes
api-versioning.md itself.

  # Python, Amazon Bedrock (default)
  from strands_harness import create_harness
  agent = create_harness()
  agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")

  # Python, Anthropic
  agent = create_harness(model="anthropic/claude-sonnet-5")

  # Python, OpenAI
  agent = create_harness(model="openai/gpt-5.4")

  # Python, Google
  agent = create_harness(model="google/gemini-2.5-flash")

  # Python, Ollama
  agent = create_harness(model="ollama/llama3.1")

  // TypeScript, Amazon Bedrock (default)
  import { createHarness } from '@strands-agents/harness'
  const agent = await createHarness()
  await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')

  // TypeScript, Anthropic
  const agent = await createHarness({ model: 'anthropic/claude-sonnet-5' })

  // TypeScript, OpenAI
  const agent = await createHarness({ model: 'openai/gpt-5.4' })

  // TypeScript, Google
  const agent = await createHarness({ model: 'google/gemini-2.5-flash' })

  // TypeScript, Ollama
  const agent = await createHarness({ model: 'ollama/llama3.1' })

For the non-Bedrock providers, keep the same import and the same invoke line as the
Bedrock snippet; only the create_harness / createHarness call changes.

Run it with: python -u agent.py  (Python)  or  npx tsx src/agent.ts  (TypeScript)

Confirm api-versioning.md was created. Explain briefly that the default agent already had
web access to research, file tools to write the recommendation, and a tuned system prompt
that had it explore before acting.

Step 4: Keep a conversation across runs
Show me that Strands harness persists conversations. Sessions are on by default with a generated
id; pass session={"id": ...} (Python) or session: { id } (TypeScript) to choose the id so a
later run can resume it. Ask a follow-up that only makes sense with the earlier context.
Strands harness stores the session under ./.agent/sessions and rehydrates it next time you build
an agent with the same id.

  # Python
  agent = create_harness(session={"id": "api-design"})
  agent("Which of those would you pick for an API with external customers, and why?")

  // TypeScript
  const agent = await createHarness({ session: { id: 'api-design' } })
  await agent.invoke("Which of those would you pick for an API with external customers, and why?")

Keep the model argument from Step 3 if I chose a non-Bedrock provider. Run the Step 3
script first so there is a conversation to resume, then run this one.

Step 5: Offer the Strands MCP server (ask first, do not install without confirmation)
Strands ships an MCP server that gives you live access to the Strands documentation while
you work, so the code you generate follows current APIs. Ask me whether I want it set up
in this coding tool. If I say yes, it requires uv (https://github.com/astral-sh/uv).
The server runs as: command "uvx", args ["strands-agents-mcp-server"]. Config locations:
  - Kiro: ~/.kiro/settings/mcp.json under "mcpServers"
  - Cursor: ~/.cursor/mcp.json under "mcpServers"
  - Claude Code: run \`claude mcp add strands uvx strands-agents-mcp-server\`
  - Codex: ~/.codex/config.toml as [mcp_servers.strands-agents]
  - VS Code: mcp.json under "servers"
If I say no, skip this step entirely.

Throughout: prefer the Strands docs at https://strandsagents.com/docs/user-guide/harness/
over memory. Strands harness returns a standard Strands Agent, so anything from the Strands Harness SDK
docs applies to it too.
`.trim()
