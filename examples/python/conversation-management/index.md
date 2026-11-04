This tutorial shows how to use **conversation managers** to control how an agent’s message history grows, shrinks, and stays within model context limits. You’ll learn the three built-in strategies: sliding window (default), null (no management), and summarizing.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | `SlidingWindowConversationManager`, `NullConversationManager`, `SummarizingConversationManager` |
| **Agent Pattern** | Single agent with different conversation management strategies |
| **Tools** | Custom mock tools for demonstrating tool-pair preservation and truncation |
| **Model** | Amazon Nova Lite on Amazon Bedrock |

## How It Works

1.  **SlidingWindowConversationManager** (default) keeps the last N messages, preserving tool-use/tool-result pairs and optionally truncating large tool outputs
2.  **NullConversationManager** does nothing — full history is sent every time, and raises an error on overflow
3.  **SummarizingConversationManager** summarizes old messages instead of dropping them, preserving context while staying within limits

## Prerequisites

-   Python 3.10 or later
-   AWS account with [Amazon Bedrock](https://aws.amazon.com/bedrock/) access configured
-   Basic familiarity with Strands Agents — see [01-first-agent](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/01-first-agent/) if needed

## Tutorial Structure

```plaintext
17-conversation-management/
├── README.md
├── requirements.txt
└── conversation-management.ipynb
```

| File | Description |
| --- | --- |
| [conversation-management.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/17-conversation-management/conversation-management.ipynb) | Step-by-step notebook covering all three conversation managers and their configuration options |

## What You’ll Learn

-   **Default behavior**: how `SlidingWindowConversationManager` works out of the box with `window_size=40`
-   **Tuning `window_size`**: choosing the right size based on your use case
-   **Tool-pair preservation**: how trimming keeps `toolUse`/`toolResult` pairs together
-   **`should_truncate_results`**: truncating large tool outputs before dropping messages
-   **`per_turn` parameter**: proactive management during tool-heavy agent loops
-   **`NullConversationManager`**: disabling management and handling overflow manually
-   **`SummarizingConversationManager`**: summarizing old messages instead of dropping them

## Installation

Install the required dependencies:

```bash
pip install -r requirements.txt
```

Then open [conversation-management.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/17-conversation-management/conversation-management.ipynb) from the `17-conversation-management/` directory.

## Related Tutorials

-   [01-first-agent](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/01-first-agent/) — creating agents (uses default conversation manager)
-   [06-memory](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/06-memory/) — persisting agent memory across sessions
-   [02-tools-and-mcp](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/02-tools-and-mcp/) — tools that generate large outputs (where truncation matters)

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/17-conversation-management)
