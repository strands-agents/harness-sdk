Before you follow along

This video is a snapshot in time. Some APIs and examples have changed since recording. Follow the code on this page, and look for “Changed since recording” notices below.

*[Watch on YouTube](https://www.youtube.com/watch?v=NAEX4ORLkbQ&list=PLDzwjhH-4yhU&index=2)*

*Code for this lesson: [`samples/02-model-providers`](https://github.com/aws-samples/sample-building-with-strands-course/tree/main/samples/02-model-providers)*

## Model choice is an architecture decision

Different models have different strengths, costs, latency characteristics, and tool-use behavior. Strands abstracts providers behind a common interface so your agent code stays the same regardless of the underlying model. Your tools, system prompt, and orchestration logic don’t change when you swap the model.

## Configuring providers

All providers follow the same pattern: instantiate a model class, pass it to the agent.

```python
from strands import Agent
from strands.models import BedrockModel
from strands.models.anthropic import AnthropicModel
from strands.models.ollama import OllamaModel
from strands.models.openai import OpenAIModel
import os

# Amazon Bedrock (default if no model specified)
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-opus-5"
)

# Anthropic direct API
anthropic_model = AnthropicModel(
    client_args={"api_key": os.environ["ANTHROPIC_API_KEY"]},
    model_id="claude-sonnet-5",
    max_tokens=1024,
)

# OpenAI
openai_model = OpenAIModel(
    client_args={"api_key": os.environ["OPENAI_API_KEY"]},
    model_id="gpt-4o",
    params={"max_tokens": 1000, "temperature": 0.7},
)

# Local with Ollama (no cloud APIs needed)
ollama_model = OllamaModel(
    host="http://localhost:11434",
    model_id="gemma4:latest",
)

# Use any provider. Agent code stays identical.
agent = Agent(model=ollama_model)
agent("Explain the agent loop in one paragraph.")
```

📂 [model\_providers.py](https://github.com/aws-samples/sample-building-with-strands-course/tree/main/samples/02-model-providers/model_providers.py)

| Provider | Install | Auth |
| --- | --- | --- |
| Bedrock (default) | `pip install strands-agents` | AWS credentials configured |
| Anthropic | `pip install "strands-agents[anthropic]"` | `ANTHROPIC_API_KEY` |
| OpenAI | `pip install "strands-agents[openai]"` | `OPENAI_API_KEY` |
| Ollama (local) | `pip install "strands-agents[ollama]"` | None, runs on your machine |

## Multi-model architectures

In sophisticated systems, different agents use different models:

-   Fast/cheap model for lightweight classification
-   Strong reasoning model for orchestration
-   Specialized model for code generation
-   A different provider entirely for evaluation/verification (avoids same-model bias)

## Ollama setup

Ollama lets you run models entirely on your machine. Useful for development, offline use, or avoiding API costs.

```bash
brew install ollama
ollama serve
ollama pull gemma4:latest
```

## Resources

-   📖 [Model Providers](/docs/user-guide/sdk/model-providers/index.md)
-   📖 [Getting Started](/docs/user-guide/sdk/quickstart/python/index.md)
-   📂 [Course Code Repository](https://github.com/aws-samples/sample-building-with-strands-course)