This tutorial covers the two ways to give a Strands agent tools: writing your own custom tools, and connecting to external Model Context Protocol (MCP) servers. You define custom tools with the `@tool` decorator and the `TOOL_SPEC` dictionary, and connect to MCP servers over stdio and Streamable HTTP transports.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | `@tool` decorator, `TOOL_SPEC`, `MCPClient` |
| **Agent Pattern** | Single agent |
| **Tools** | Custom tools (`@tool`, `TOOL_SPEC`), MCP tools |
| **Model** | Claude Sonnet 4.5 on Amazon Bedrock (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) |

## Key Concepts

-   **Custom tools**: Define your own tools with the `@tool` decorator (a typed function plus a docstring) or with the `TOOL_SPEC` dictionary, which gives explicit control over the input schema and success or error results.
-   **Model Context Protocol (MCP)**: An open protocol for connecting agents to external tool servers. The `MCPClient` connects over stdio or Streamable HTTP and exposes the server’s tools, prompts, and resources.
-   **Direct tool invocation**: Call a tool yourself with `agent.tool.<name>` without going through the model.

## Prerequisites

-   Python 3.10 or higher
-   An AWS account with credentials configured
-   Access to Anthropic Claude Sonnet 4.5 (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) on Amazon Bedrock (see [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html))
-   Basic understanding of Python

## Tutorial Structure

| Path | Description |
| --- | --- |
| [01-using-mcp-tools/mcp-agent.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/02-tools-and-mcp/01-using-mcp-tools/mcp-agent.ipynb) | Connect an agent to MCP servers over stdio and Streamable HTTP, use multiple servers together, and invoke MCP tools directly |
| [02-custom-tools/custom-tools-with-strands-agents.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/02-tools-and-mcp/02-custom-tools/custom-tools-with-strands-agents.ipynb) | Build custom tools with the `@tool` decorator and the `TOOL_SPEC` dictionary, handle tool errors, and inspect tool results |

## Getting Started

Each sub-sample is self-contained and has its own `requirements.txt`. Pick the one you want to run, install its dependencies, and open its notebook.

1.  **Install dependencies:**
    
    ```bash
    cd 01-using-mcp-tools        # or: cd 02-custom-tools
    pip install -r requirements.txt
    ```
    
2.  **Run the notebook** in that folder and run the cells in order.
    

## Project Structure

```plaintext
02-tools-and-mcp/
├── 01-using-mcp-tools/
│   ├── mcp-agent.ipynb
│   ├── requirements.txt
│   └── images/
├── 02-custom-tools/
│   ├── custom-tools-with-strands-agents.ipynb
│   ├── requirements.txt
│   └── images/
└── README.md
```

## Cleanup

The custom-tools notebook creates a local SQLite file (`appointments.db`) in its folder; delete it to reset. No persistent AWS resources are created.

## Additional Resources

-   [Custom tools](https://strandsagents.com/docs/user-guide/concepts/tools/custom-tools/)
-   [MCP tools](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)
-   [Model Context Protocol](https://modelcontextprotocol.io/)
-   [strands-agents-tools](https://github.com/strands-agents/tools) repository for pre-implemented tools

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/02-tools-and-mcp)
