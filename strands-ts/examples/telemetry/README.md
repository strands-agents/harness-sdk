# Strands Agents — Jaeger Tracing Example

Send traces from a Strands agent to a local [Jaeger](https://www.jaegertracing.io/) instance and visualize them in the Jaeger UI.

## Architecture

```mermaid
flowchart LR
    A["Strands Agent<br/>(your code)"] -- OTLP --> B["OTel Collector<br/>(batch + export)<br/>localhost:4318"]
    B -- OTLP --> C["Jaeger<br/>(traces)<br/>localhost:16686"]
```

The agent exports spans over OTLP HTTP to an OpenTelemetry Collector, which
batches and forwards them to Jaeger. Both the collector and Jaeger run locally
via Docker Compose.

## Prerequisites

- Docker (or [Finch](https://github.com/runfinch/finch))
- Node.js 22+
- AWS credentials configured (for Bedrock model access)

## Quick Start

1. Start Jaeger and the OTel Collector:

```bash
docker compose up -d
```

(Or `finch compose up -d` if using Finch.)

2. Install dependencies:

```bash
npm install
```

3. Run the example:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm start
```

4. Open the Jaeger UI at [http://localhost:16686](http://localhost:16686).
   Select `strands-agents` from the service dropdown and click **Find Traces**.

   You'll see the full trace hierarchy — agent invocation, loop cycles, model
   calls, and tool executions nested under each agent span.

5. Tear down when done:

```bash
docker compose down
```