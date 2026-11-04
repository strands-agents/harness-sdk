Minimal proof-of-concept for a personal dining assistant agent using Zep AI’s graph-based memory and the Strands framework.

## Overview

-   Demonstrates semantic, episodic, and procedural memory
-   Showcases graph memory for user preferences, experiences, and context-aware recommendations
-   Integrates mock APIs for calendar and restaurant booking

## 🆚 Zep vs Traditional Memory Approaches

| Feature | Traditional | Zep Graph Memory |
| --- | --- | --- |
| Memory Structure | Flat key-value storage | Connected knowledge graph |
| Relationship Handling | Limited associations | Rich relationship modeling |
| Temporal Preferences | Difficult to distinguish | Built-in temporal handling |
| Context Understanding | Context lost over time | Context preserved in graph |
| Scalability | Storage limitations | Scales with connections |
| Query Capability | Simple text search | Semantic graph search |
| Learning Speed | Requires manual curation | Automatic learning & inference |

💡 **Real-world Impact:**

-   🎯 More accurate recommendations based on relationship context
-   ⏰ Better handling of changing preferences over time
-   🧠 Richer understanding of user behavior patterns
-   🔄 Self-improving system through graph connections
-   🎪 Enhanced user experience through personalization

## Architecture

-   **Agent Framework:** Strands
-   **Memory:** Zep AI (graph-based)
-   **APIs:** Mock calendar, mock booking

## Demo

-   Jupyter notebook walks through preference discovery, conflict resolution, memory evolution, and booking
-   Visualizes memory graph and agent reasoning

## Requirements

-   Python 3.12+
-   [uv](https://docs.astral.sh/uv/getting-started/installation/)
-   [Zep API key](https://help.getzep.com/quickstart#obtain-an-api-key)

## Getting Started

1.  Open a new terminal
    
2.  Copy the `.env.example` file to `.env`:
    

```bash
cp .env.example .env
```

3.  Edit the .env file and add your Zep API key
    
4.  Install the dependencies and run the following command to start the jupyter notebook in a new browser tab:
    

```bash
uv run --with jupyter jupyter lab
```

This will open a new browser tab with the jupyter notebook on [http://localhost:8888/lab](http://localhost:8888/lab). You can then navigate to the `dining-assistant/zep-dining-assistant.ipynb` notebook.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/memory/zep-ai)
