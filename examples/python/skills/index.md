This tutorial shows how to use **skills** to keep agent instructions modular and context-window lean. Instead of a single monolithic system prompt, skills are `SKILL.md` files loaded on demand when the agent decides they are relevant.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | `AgentSkills` plugin, `Skill` dataclass, `@tool` decorator |
| **Agent Pattern** | Single agent with skill-based instruction routing |
| **Tools** | Custom mock tools, `file_read` from strands-agents-tools |
| **Model** | Amazon Nova Lite on Amazon Bedrock |

## How It Works

1.  Skills are stored as `SKILL.md` files in subdirectories under `skills/`
2.  `AgentSkills` scans the directory and injects a compact `<available_skills>` summary into the system prompt
3.  When a user message matches a skill’s domain, the agent calls the built-in `skills` tool to load the full instructions
4.  The skill can reference additional files (e.g. checklists, escalation guides) via `file_read`

## Prerequisites

-   Python 3.10 or later
-   AWS account with [Amazon Bedrock](https://aws.amazon.com/bedrock/) access configured
-   Basic familiarity with Strands Agents — see [01-first-agent](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/01-first-agent/) if needed

## Tutorial Structure

```plaintext
15-skills/
├── README.md
├── requirements.txt
├── agent-skills.ipynb
└── skills/
    ├── returns-policy/
    │   ├── SKILL.md
    │   └── references/
    │       └── returns-checklist.md
    └── technical-troubleshooting/
        ├── SKILL.md
        └── references/
            └── escalation-guide.md
```

| File | Description |
| --- | --- |
| [agent-skills.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/15-skills/agent-skills.ipynb) | Step-by-step notebook covering skill creation, plugin setup, and runtime skill injection |

## What You’ll Learn

-   **`SKILL.md` structure**: front-matter (`name`, `description`, `allowed-tools`) + instruction body
-   **`AgentSkills` plugin**: how it scans a directory, injects a skill summary, and loads full instructions on demand
-   **Reference files**: how skills use `file_read` to load supporting documents at activation time
-   **Programmatic skills**: creating a `Skill(...)` object at runtime without touching the filesystem
-   **Runtime updates**: using `set_available_skills` to add or replace skills mid-session

## Installation

Install the required dependencies:

```bash
pip install -r requirements.txt
```

Then open [agent-skills.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/15-skills/agent-skills.ipynb) from the `15-skills/` directory so that relative paths to `./skills/` resolve correctly.

## Related Tutorials

-   [02-tools-and-mcp](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/02-tools-and-mcp/) — building the tools that skills rely on
-   [06-memory](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/06-memory/) — combining skills with persistent memory
-   [13-human-in-the-loop](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/13-human-in-the-loop/) — hooks and agent lifecycle events

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/15-skills)
