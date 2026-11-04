[![PyPI](https://img.shields.io/pypi/v/strands-research-agent)](https://pypi.org/project/strands-research-agent/)

Sample research agent that creates its own tools and gets smarter over time.

## What is this?

A research agent that can:

-   **Create custom tools** while you chat (saves Python files, instantly available)
-   **Remember conversations** across sessions (builds knowledge over time)
-   **Work with multiple AI models** (use the best model for each task)
-   **Run background research** (spawn specialist agents to work independently)

## Quick Start

```bash
# Install
pipx install strands-research-agent

# Run
strands-research-agent
# or
research-agent
```

**⚠️ Setup Required:** The default model provider is AWS Bedrock, which requires:

-   AWS CLI configured (`aws configure`)
-   Access to Claude models in AWS Bedrock console

Once configured, the agent will:

-   Answer questions using web search and analysis
-   Create tools as needed and save them to `./tools/`
-   Remember your conversations for context

## Why use this?

**Traditional AI:** Fixed capabilities, no memory, starts fresh every time

**Research Agent:**

-   **Self-expanding** - creates new tools based on what you need
-   **Persistent** - remembers your research across sessions
-   **Multi-model** - can use different AI models for different tasks

## Installation & Setup

**Requirements:** Python 3.10+

### Option 1: Quick Install (Recommended)

```bash
pipx install strands-research-agent
strands-research-agent
```

### Option 2: With More AI Models

```bash
pipx install strands-research-agent[all]
research-agent
```

### Option 3: Development Setup

```bash
git clone https://github.com/strands-agents/samples.git
cd samples/python/04-industry-use-cases/productivity/research-agent
pip install -e .[dev]
strands-research-agent
```

**AWS Setup (Required):**

Default model provider is AWS Bedrock:

```bash
# Configure AWS credentials
aws configure

# Enable Claude models in AWS console:
# https://console.aws.amazon.com/bedrock/home#/modelaccess
```

**Alternative Models (Optional):**

For non-AWS setups:

```bash
# Use local Ollama models
export MODEL_PROVIDER="ollama"
# (requires ollama installed locally)
```

## What makes it different?

### 1\. Tool Creation

Ask the agent to create tools and it writes Python code for you:

```plaintext
You: "Create a tool to analyze GitHub repositories"
Agent: *writes GitHub analyzer tool to ./tools/github_analyzer.py*
Agent: "Tool created! Now analyzing repositories..."
```

The tool is immediately available - no restart needed.

### 2\. Background Research

Start long research tasks that run while you do other things:

```python
# Start background research
agent.tool.tasks(
    action="create",
    task_id="market_research",
    prompt="Research AI agent market trends for 2024"
)

# Continue chatting while research runs in background
# Check progress later with:
agent.tool.tasks(action="status", task_id="market_research")
```

### 3\. Multiple AI Models

Use different models for different types of thinking:

```python
# Use GPT-4 for code analysis (logical)
agent.tool.use_agent(
    prompt="Review this code architecture",
    model_provider="openai"
)

# Use Claude for creative strategy (intuitive)
agent.tool.use_agent(
    prompt="Brainstorm marketing strategies",
    model_provider="anthropic"
)
```

## Key Tools

**Research & Analysis**

-   `scraper` - Extract data from websites
-   `http_request` - API calls with authentication
-   `python_repl` - Run Python code for calculations
-   `calculator` - Math and calculations

**File Operations**

-   `editor` - Create/modify files
-   `file_read`/`file_write` - File operations
-   `shell` - Command line access

**Multi-Agent**

-   `tasks` - Background processing
-   `use_agent` - Delegate to specialist agents
-   `swarm` - Coordinate teams of agents
-   `workflow` - Complex multi-step processes

**Memory & Learning**

-   `store_in_kb` - Save knowledge permanently
-   `retrieve` - Find relevant past knowledge
-   `system_prompt` - Modify agent behavior

## AI Models Supported

-   **AWS Bedrock Claude** (default, requires AWS setup)
-   **OpenAI GPT-4/GPT-4o**
-   **Ollama** (local models)
-   **Anthropic Claude** (direct API)

Different models have different strengths - the agent can automatically choose the right one for each task.

## Common Use Cases

### Research Projects

```plaintext
"Research the current state of autonomous vehicles and create a competitive analysis report"
```

### Data Analysis

```plaintext
"Analyze this CSV file and create visualizations showing trends over time"
```

### Code & Tech Research

```plaintext
"Compare the top 5 Python web frameworks and recommend the best one for my project"
```

### Content Creation

```plaintext
"Research my industry and create social media content ideas for the next month"
```

## Advanced Features

### Custom Tool Creation

The agent can write Python tools for you:

```python
# Ask for custom functionality
agent("Create a tool that monitors cryptocurrency prices")

# Agent creates ./tools/crypto_monitor.py with full implementation
# Tool becomes available immediately as agent.tool.crypto_monitor()
```

### Persistent Memory

Conversations and knowledge accumulate across sessions:

```python
# Session 1: Research AI frameworks
agent("What are the best AI agent frameworks?")

# Session 2 (days later): Agent remembers previous research
agent("Which of those frameworks we discussed has the best multi-agent support?")
# Agent: "Based on our previous analysis of AI frameworks..."
```

## How it Works

```plaintext
📦 research-agent/
├── agent.py           # Main chat interface
├── tools/             # Custom tools (auto-created by agent)
│   └── *.py          # Tools created during conversations
└── .prompt           # Agent personality & instructions
```

The agent:

1.  **Listens** to your questions
2.  **Creates tools** if needed (saves Python files to `./tools/`)
3.  **Uses tools** to research and analyze
4.  **Remembers** conversations for future sessions
5.  **Gets smarter** over time through accumulated knowledge

## Need Help?

-   **Documentation:** [Strands Agents SDK](https://strandsagents.com/)
-   **Issues:** [GitHub Issues](https://github.com/strands-agents/samples/issues)
-   **Examples:** Check the `./tools/` directory after chatting with the agent

## Contributing

Want to improve the research agent?

1.  Fork on GitHub
2.  Clone locally: `git clone your-fork-url`
3.  Install dev dependencies: `pip install -e .[dev]`
4.  Make changes
5.  Test with `strands-research-agent`
6.  Submit pull request

The agent creates tools in real-time, so you can see your changes immediately.

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.

---

*Built with [Strands Agents SDK](https://strandsagents.com)*

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/productivity/research-agent)
