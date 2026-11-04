This sample demonstrates Strands’ native support for the Agent-to-Agent (A2A) protocol, showcasing how to create both A2A servers and clients for inter-agent communication.

## Overview

The sample includes:

-   **Server**: A Strands agent equipped with a calculator tool that exposes its capabilities via the A2A protocol
-   **Client Examples**: Three different ways to interact with the A2A server:
    -   Using a Strands agent with A2A client tools
    -   Direct streaming communication
    -   Direct synchronous communication

## Components

### Server (`server.py`)

Creates a Strands agent with calculator tool and exposes it via an A2A server running on `http://localhost:9000`.

### Client Examples

1.  **Agent Client (`client_agent.py`)**:
    
    -   Uses a Strands agent equipped with A2A client tools
    -   Demonstrates how agents can discover and communicate with other agents
    -   Automatically picks an available agent and tests its functionality
2.  **Streaming Client (`client_streaming.py`)**:
    
    -   Shows direct A2A communication using streaming responses
    -   Demonstrates real-time message processing
    -   Example: Calculates “123 \* 12” with streaming output
3.  **Synchronous Client (`client_sync.py`)**:
    
    -   Shows direct A2A communication using synchronous requests
    -   Demonstrates standard request-response pattern
    -   Example: Calculates “3 to the power of 7”

## Running the Sample

### Prerequisites

Ensure sure you have `uv` installed, then install the required dependencies:

### Optionally use a virtual environment

```bash
uv venv && source .venv/bin/activate
```

### Install Dependencies

```bash
uv sync
```

### Step 1: Start the Server

In your first terminal, start the A2A server:

```bash
uv run server.py
```

The server will start on `http://localhost:9000` and expose the calculator agent’s capabilities.

### Step 2: Test the Clients

In separate terminals, you can test each client example:

#### Agent-based Client

```bash
uv run client_agent.py
```

This will use a Strands agent to discover and interact with the server agent.

#### Streaming Client

```bash
uv run client_streaming.py
```

This will send a streaming request to calculate “123 \* 12” and display the real-time response.

#### Synchronous Client

```bash
uv run client_sync.py
```

This will send a synchronous request to calculate “3 to the power of 7” and display the response.

## Notes

-   The server must be running before any client examples will work
-   All examples use `localhost:9000` as the default server URL

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/protocols/a2a-native)
