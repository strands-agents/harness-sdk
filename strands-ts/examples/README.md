# Examples

Sample applications demonstrating Strands Agents TypeScript SDK features.

## Prerequisites

- Node.js 22+
- AWS credentials configured (for the default Bedrock model provider)

## Running an Example

Each example is a standalone project. From any example directory:

```bash
npm install
npm start
```

## Available Examples

| Example | Description |
|---------|-------------|
| [first-agent](./first-agent/) | Basic agent usage with tools, invoke, and streaming patterns |
| [graph](./graph/) | Graph multi-agent orchestration (linear, fan-out, streaming) |
| [swarm](./swarm/) | Swarm multi-agent orchestration (agent-driven handoffs) |
| [mcp](./mcp/) | Model Context Protocol integration with external tool servers |
| [agents-as-tools](./agents-as-tools/) | Agents as tools pattern (orchestrator delegates to specialized tool agents) |
| [browser-agent](./browser-agent/) | Browser-based agent with DOM manipulation canvas (OpenAI, Anthropic, Bedrock) |
| [bidi-console](./bidi-console/) | Bidirectional streaming agent with console (text) input and output |
| [bidi-playground](./bidi-playground/) | Nova Sonic voice or text agent in the terminal with tools, bidi hooks, and a session summary |
| [bidi-browser](./bidi-browser/) | Browser-only voice agent: Nova Sonic, OpenAI Realtime, or Gemini Live with BrowserAudioIO and BrowserSandbox (see its [README](./bidi-browser/README.md)) |
| [bidi-websocket](./bidi-websocket/) | Bidirectional streaming voice agent served over a WebSocket (see its [README](./bidi-websocket/README.md)) |
| [telemetry](./telemetry/) | OpenTelemetry tracing with Jaeger (requires Docker, see its [README](./telemetry/README.md)) |
| [decisions](./decisions/) | Decision-model primitive — ask closed questions with typed answers and `Uncertain(reason)` |
