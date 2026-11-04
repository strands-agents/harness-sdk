An expert agile development assistant for JIRA specializing in breaking down meeting notes into actionable tasks. Using this implementation, product teams can convert high-level plan items from biweekly planning meetings into well-structured, detailed Jira tickets.

![architecture](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/productivity/scrum-master-assistant/architecture.png)

| Feature | Description |
| --- | --- |
| Agent Structure | Single-agent architecture |
| Native Tools | file\_read |
| Custom Agents | create\_jira\_ticket |
| Model Provider | Amazon Bedrock |

## Getting Started

1.  Install [uv](https://docs.astral.sh/uv/getting-started/installation/).
    
2.  Set up AWS credentials in `.env` using [.env.example](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/productivity/scrum-master-assistant/.env.example).
    
3.  Run the SCRUM Master Assistant using `uv run jira_assistant.py`

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/productivity/scrum-master-assistant)
