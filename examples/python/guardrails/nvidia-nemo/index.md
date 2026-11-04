Example for integrating Strands Agent with [NVIDIA NeMo Guardrails](https://developer.nvidia.com/nemo-guardrails) for configurable, rule-based content filtering and conversation flow control.

NeMo Guardrails provides a toolkit for creating customizable guardrails that can control and guide AI conversations through predefined rules and flows.

## Prerequisites

1.  Python 3.8+ installed
2.  NeMo Guardrails package (included in requirements.txt)
3.  Basic understanding of NeMo configuration files

## Installation

1.  Install dependencies:

```bash
pip install -r requirements.txt
```

Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/), so that you can run the NVIDIA NeMo server separately.

You may also need build-essentials installed to run the NVIDIA NeMo server

```plaintext
sudo apt-get update
sudo apt-get install -y build-essentials
```

## Usage

1.  Start the NeMo Guardrails server:

```bash
cd nemo-guardrail-examples
uvx nemoguardrails server --config .
```

2.  In another terminal, run the Strands Agent example:

```bash
python main.py
```

The agent will communicate with the NeMo Guardrails server to validate and filter content based on the configured rules. On first pass, the nvidia server will download a local model.

**main.py**

```plaintext
$ python3 main.py
Guardrail check passed, proceeding with request.
I'm doing well, thank you for asking! How can I assist you today?Guardrail check passed, proceeding with request.
❌ Message blocked by guardrail: Guardrail check failed: Content not allowed - Message: 'You're a dummy' (got: 'DENY')
```

**NVIDIA NeMo server**

```plaintext
$ uvx nemoguardrails server --config .
INFO:     Started server process [21327]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:nemoguardrails.server.api:Got request for config my-first-guardrail
Entered verbose mode.
17:55:55.287 | Registered Actions ['ClavataCheckAction', 'GetAttentionPercentageAction', 'GetCurrentDateTimeAction',
'UpdateAttentionMaterializedViewAction', 'alignscore request', 'alignscore_check_facts', 'autoalign_factcheck_output_api',
'autoalign_groundedness_output_api', 'autoalign_input_api', 'autoalign_output_api', 'call cleanlab api', 'call fiddler faithfulness', 'call fiddler
safety on bot message', 'call fiddler safety on user message', 'call gcpnlp api', 'call_activefence_api', 'content_safety_check_input',
'content_safety_check_output', 'create_event', 'detect_pii', 'detect_sensitive_data', 'injection_detection', 'jailbreak_detection_heuristics',
'jailbreak_detection_model', 'llama_guard_check_input', 'llama_guard_check_output', 'mask_pii', 'mask_sensitive_data', 'patronus_api_check_output',
'patronus_lynx_check_output_hallucination', 'protect_text', 'retrieve_relevant_chunks', 'self_check_facts', 'self_check_hallucination',
'self_check_input', 'self_check_output', 'summarize_document', 'topic_safety_check_input', 'wolfram alpha request']
...
INFO:     127.0.0.1:43202 - "POST /v1/chat/completions HTTP/1.1" 200 OK
INFO:     127.0.0.1:43218 - "POST /v1/chat/completions HTTP/1.1" 200 OK
INFO:     127.0.0.1:43222 - "POST /v1/chat/completions HTTP/1.1" 200 OK
```

## Files

-   `main.py` - Strands Agent with NeMo Guardrails integration
-   `guardrail.py` - NeMo Guardrails client implementation
-   `requirements.txt` - Python dependencies including nemoguardrails
-   `nemo-guardrail-examples/` - Configuration directory for NeMo server
    -   `my-first-guardrail/` - Example guardrail configuration
        -   `config.yml` - Main configuration file
        -   `rails/` - Custom rails definitions

## How It Works

The example runs NeMo Guardrails in server mode and communicates via REST API. The Strands Agent sends messages to the NeMo server for validation before processing.

### Server API

Send POST requests to: `http://127.0.0.1:8000/v1/chat/completions`

Payload format:

```json
{
    "config_id": "my-first-guardrail",
    "messages": [{
        "role": "user",
        "content": "hello there"
    }]
}
```

Where `config_id` matches guardrail name.

## Configuration

The `config.yml` file defines:

-   Conversation flows and rules
-   Input/output filtering policies
-   Custom rails for specific use cases
-   Integration with external services

See the [NeMo Guardrails documentation](https://docs.nvidia.com/nemo/guardrails/) for detailed configuration options.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/guardrails/nvidia-nemo)
