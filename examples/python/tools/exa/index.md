A conversational AI agent that demonstrates the full power of Exa’s search and content extraction capabilities through a practical research workflow using Strands Agents.

## Overview

[Exa](https://exa.ai/) is a search API specifically designed for AI applications. Unlike traditional search engines, Exa provides semantic search capabilities, content extraction, and structured output that AI agents can directly consume. This integration demonstrates how to build a Deep Research Assistant using Strands Agents and Exa’s powerful search tools.

## Exa Capabilities Demonstrated

| Feature | Description |
| --- | --- |
| Auto Mode | Intelligent search mode selection for optimal results |
| Category Filtering | Specialized searches for news, research papers, and GitHub repositories |
| Date Filtering | Time-bound searches for recent content (e.g., last 30 days) |
| AI Summaries | Automatic key insights extraction from search results |
| Structured Output | JSON schema for structured summary extraction |
| Subpage Crawling | Discover related pages (citations, methodology, references) |
| Subpage Targeting | Keywords to find specific subpages (references, bibliography) |
| Highlights | Token-efficient page excerpts for key information |
| Content Freshness | max\_age\_hours for livecrawl control (replaces old livecrawl enum) |
| Content Extraction | Full text retrieval with character limit control |

## Architecture

The Deep Research Assistant implements a comprehensive 6-step research workflow:

```plaintext
┌───────────────────────────────────────────────────────────────────┐
│                    Deep Research Assistant                        │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────┐     ┌──────────────────┐     ┌─────────────────┐   │
│  │  User     │────▶│  Strands Agent   │────▶│   Exa Tools     │   │
│  │  Query    │     │ (Claude/Amazon   │     │                 │   │
│  │           │     │  Bedrock)        │     │                 │   │
│  └───────────┘     └──────────────────┘     │  • exa_search   │   │
│                             │               │  • exa_get_     │   │
│                             │               │    contents     │   │
│                             ▼               └─────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              6-Step Research Workflow                       │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │ 1. Overview Search  │ Auto mode + subpages + AI summaries   │  │
│  │ 2. News Search      │ Category: news + date filtering       │  │
│  │ 3. Academic Papers  │ Category: research paper + structured │  │
│  │ 4. GitHub Projects  │ Category: github                      │  │
│  │ 5. Deep Dive        │ exa_get_contents + highlights         │  │
│  │ 6. Synthesis        │ Comprehensive research brief          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Research Output Structure

The agent produces a comprehensive research brief including:

-   **Executive Summary** - 2-3 sentence overview
-   **Topic Overview** - Key concepts and background
-   **Recent Developments** - Latest news and announcements
-   **Key Research & Papers** - Academic findings
-   **Tools & Implementations** - GitHub projects and libraries
-   **Deep Dive Insights** - Detailed content extraction
-   **Sources** - All URLs organized by category

## Prerequisites

1.  **Python 3.11+** - Required Python version
2.  **[uv](https://docs.astral.sh/uv/getting-started/installation/)** - Fast Python package manager
3.  **AWS Credentials** - Configure AWS CLI for Amazon Bedrock access:
    
    ```bash
    aws configure
    ```
    
4.  **Exa API Key** - Get one at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)

## Getting Started

1.  Copy the `.env.example` file to `.env`:
    
    ```bash
    cp .env.example .env
    ```
    
2.  Edit the `.env` file and add your Exa API key:
    
    ```bash
    EXA_API_KEY=your-exa-api-key-here
    ```
    
3.  Run the Deep Research Assistant:
    
    **Using uv (recommended)**
    
    ```bash
    uv run deep_research_assistant.py
    
    # Or with a specific research query
    uv run deep_research_assistant.py "What are the latest advances in quantum computing?"
    ```
    
    **Using pip**
    
    ```bash
    pip install -r requirements.txt
    python deep_research_assistant.py
    ```
    

## Setup with Local Observability (Jaeger)

The quickest way to visualize agent traces is using a local OTEL collector with Jaeger.

### Start Jaeger

```bash
docker run -d --name jaeger \
  -p 4317:4317 \
  -p 4318:4318 \
  -p 16686:16686 \
  jaegertracing/all-in-one:latest
```

### Run with Instrumentation

```bash
# Load environment variables and run with uv
set -a && source .env && set +a
uv run opentelemetry-instrument python deep_research_assistant.py

# Or with a specific query
uv run opentelemetry-instrument python deep_research_assistant.py "your research query"
```

### View Traces

Open the Jaeger UI at [http://localhost:16686/](http://localhost:16686/) to view traces, spans, and agent execution flow.

---

## Advanced: Setup with AWS CloudWatch Observability

Amazon Bedrock AgentCore Observability helps you trace, debug, and monitor agent performance. This data is available in Amazon CloudWatch. To view the full range of observability data or output custom runtime metrics, you need to instrument your code using the AWS Distro for OpenTelemetry (ADOT) SDK. We will visualise the Exa deep researcher agent on CloudWatch GenAI Observability Dashboard.

### Prerequisites for CloudWatch Observability

1.  **Enable Transaction Search on Amazon CloudWatch** - Required for viewing observability data
    
    -   [Enable Transaction Search Documentation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html)
2.  **AWS Permissions** - Ensure your AWS IAM user/role has the appropriate CloudWatch permissions for Amazon Bedrock AgentCore Observability
    
3.  **AWS Distro for OpenTelemetry (ADOT)** - Required for full observability features
    
    -   [Amazon Bedrock AgentCore Observability Configuration Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html)

### Running with CloudWatch Observability

1.  Run the setup script with observability:
    
    ```bash
    ./setup-with-observability.sh
    ```
    
    This will:
    
    -   Create a virtual environment
    -   Install dependencies including OpenTelemetry
    -   Create `.env` file from the observability template
    -   Configure CloudWatch resources
2.  Edit the `.env` file and add your Exa API key:
    
    ```bash
    EXA_API_KEY=your-exa-api-key-here
    ```
    
3.  Execute with observability instrumentation:
    
    ```bash
    # Activate environment and load observability settings
    source .venv/bin/activate
    source .env  # Load observability environment variables
    
    # Run with OpenTelemetry instrumentation
    opentelemetry-instrument python deep_research_assistant.py "your search query"
    
    # Using uv
    uv run opentelemetry-instrument python deep_research_assistant.py "your search query"
    ```
    

### Viewing CloudWatch Observability Data

To view the observability dashboard in CloudWatch:

1.  Open the Amazon CloudWatch console
2.  Navigate to the GenAI Observability page
3.  Select your application: `exa-deep-research`

The dashboard provides:

-   End-to-end trace analysis of the research workflow
-   Search performance metrics for each Exa operation
-   Token usage and cost tracking
-   Tool execution timing and success rates
-   Agent decision tracking and reasoning flow

## Usage Options

### Interactive Mode

Run without arguments to enter interactive mode:

```bash
uv run deep_research_assistant.py
```

You’ll be prompted to:

1.  Run a demo query (battery technology for EVs)
2.  Enter interactive mode for multiple queries

### Single Query Mode

Pass your research question as an argument:

```bash
uv run deep_research_assistant.py "What are the latest advances in battery technology for electric vehicles?"
```

## Example Conversation

```plaintext
Research Query: What are the latest advances in quantum computing?

## Research Brief: Quantum Computing Advances

### Executive Summary
Recent breakthroughs in quantum error correction and hardware stability have pushed
quantum computing closer to practical applications...

### Topic Overview
Quantum computing leverages quantum mechanical phenomena like superposition and
entanglement to perform computations...

### Recent Developments
- IBM announced a 1,121-qubit processor "Condor"
- Google achieved quantum supremacy milestone...

### Key Research & Papers
- "Logical qubit demonstration using trapped ions" - Nature Physics
- "Quantum error correction threshold exceeded" - Science...

### Tools & Implementations
- Qiskit - IBM's open-source quantum computing framework
- Cirq - Google's quantum computing library...

### Sources
[URLs organized by search category]
```

## Project Structure

```plaintext
exa/
├── deep_research_assistant.py      # Main agent with Exa tool integration
├── .prompt                         # System prompt defining research workflow
├── .env.example                    # Basic environment variables template
├── .env-obs.example                # Observability environment template
├── setup-new.sh                    # Basic setup script
├── setup-with-observability.sh     # Setup script with AWS CloudWatch integration
├── setup-observability.py          # Observability configuration script
├── .gitignore                      # Git ignore rules
├── requirements.txt                # Python dependencies (pip)
├── pyproject.toml                  # Project dependencies (uv)
└── README.md                       # This file
```

## Dependencies

-   **strands-agents** - Strands Agents Open source framework
-   **strands-agents-tools** - Exa tools integration (exa\_search, exa\_get\_contents)
-   **boto3** - AWS SDK for Amazon Bedrock integration
-   **aws-opentelemetry-distro** - AWS Opentelemetry python package ( For Amazon Bedrock AgentCore observability on Amazon Cloudwatch)

## Resources

-   [Strands Agents SDK](https://strandsagents.com)
-   [Exa API Documentation](https://docs.exa.ai)
-   [Amazon Bedrock](https://aws.amazon.com/bedrock/)
-   [Exa Dashboard](https://dashboard.exa.ai)
-   [Amazon Bedrock AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html)

## Security

This sample uses [Amazon Bedrock](https://aws.amazon.com/bedrock/) for model inference and [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/) for observability. Both services process data in your AWS account; review their documentation for data handling and encryption details. This is an non-production example.

### IAM Permissions

Apply [least-privilege permissions](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege) when configuring AWS credentials. Grant only the Amazon Bedrock and Amazon CloudWatch actions required by this sample.

### Shared Responsibility

Security and compliance are shared responsibilities between AWS and the customer. See the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/) for details.

### Credential Management

Store API keys (such as `EXA_API_KEY`) securely using environment variables and never commit them to source control. For production deployments, consider using [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) to manage sensitive credentials.

### Third-Party Services

[Exa](https://exa.ai/) is a third-party search service. Review Exa’s terms of service and content licensing before using search results. This is an non-production example.

### Recommended Security Measures

1.  **Credential management** — Rotate API keys regularly; use AWS Secrets Manager in production.
2.  **Least-privilege IAM** — Scope IAM policies to only the actions and resources this sample requires.
3.  **Input validation** — Validate and sanitize all user-supplied queries before passing them to the agent.
4.  **Logging and monitoring** — Enable Amazon CloudWatch logging to audit agent activity and detect anomalies.

### Clean up

Clean up the resources created on AWS to avoid undesired costs.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/tools/exa)
