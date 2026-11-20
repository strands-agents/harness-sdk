An expert agile development assistant for JIRA specializing in breaking down meeting notes into actionable tasks. Using this implementation, product teams can convert high-level plan items from biweekly planning meetings into well-structured, detailed Jira tickets.

![architecture](https://raw.githubusercontent.com/strands-agents/samples/6226307ed8f6de1face333d3daec638593aeedf3/python/04-industry-use-cases/productivity/scrum-master-assistant/architecture.png)

| Feature | Description |
| --- | --- |
| Agent Structure | Single-agent architecture |
| Native Tools | file\_read |
| Custom Agents | create\_jira\_ticket |
| Model Provider | Amazon Bedrock |

## Getting Started

1.  Install [uv](https://docs.astral.sh/uv/getting-started/installation/).
    
2.  Set up AWS credentials in `.env` using [.env.example](https://github.com/strands-agents/samples/blob/6226307ed8f6de1face333d3daec638593aeedf3/python/04-industry-use-cases/productivity/scrum-master-assistant/.env.example).
    
3.  Run the SCRUM Master Assistant using `uv run jira_assistant.py`

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/6226307ed8f6de1face333d3daec638593aeedf3/python/04-industry-use-cases/productivity/scrum-master-assistant)
