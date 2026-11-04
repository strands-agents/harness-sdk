An agent that picks the best Pokémon for competitive team building. Demonstrates three Strands features working together:

-   **Context management** (`context_manager="auto"`) — offloads large API responses to disk, summarizes old conversation turns
-   **Strands Shell** (via MCP) — sandboxed jq/grep for querying offloaded content without loading it back into context
-   **Strands Evals** — chaos testing (tool failures) and red teaming (sandbox escape attempts)

## Setup

```bash
chmod +x setup.sh && ./setup.sh
```

This downloads a subset of [PokeAPI/api-data](https://github.com/PokeAPI/api-data) (~400MB, sparse checkout of pokemon + move + type data).

## Run the agent

```bash
uv run demo_agent.py
```

The agent answers competitive Pokémon questions by cross-referencing large JSON files (538KB per Pokémon, 77KB per move). Each response triggers context offloading. The agent uses jq through the sandboxed shell to query offloaded content surgically.

## Run evals

```bash
uv run demo_evals.py
```

Two phases:

1.  **Chaos testing** — injects Timeout, NetworkError, and TruncateFields on the domain tools. Verifies the agent still finds the correct answer under each failure condition.
2.  **Red teaming** — auto-generates adversarial attacks (data exfiltration, excessive agency) using `AdversarialCaseGenerator`, then runs `CrescendoStrategy` to probe the Shell sandbox boundary.

## How it works

The agent has two domain tools (`get_pokemon`, `get_move`) that simulate API calls by reading from the PokeAPI JSON dataset. These return full responses (77KB-538KB) that exceed the context offloader’s threshold. The offloader stores them to `./artifacts/` and the agent sees a truncated preview plus the storage path.

Strands Shell (via MCP) mounts `./artifacts/` at `/artifacts/` in a sandboxed virtual filesystem. The agent queries offloaded content with jq without it re-entering the context window. Shell also mounts the dataset at `/pokedata/` read-only.

`context_manager="auto"` composes both the offloader and a summarizing conversation manager with ContextBench-tuned defaults.

## Requirements

-   Python 3.10+
-   AWS credentials configured (uses Bedrock by default)
-   `uv` for dependency management

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/05-technical-use-cases/pokemon-team-advisor)
