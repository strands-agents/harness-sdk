These notebooks demonstrate how to wrap specialized agents as callable tools and coordinate them from an orchestrator agent.

## Notebooks

| Notebook | What it covers |
| --- | --- |
| [`agent-as-tools.ipynb`](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/10-agents-as-tools/agent-as-tools.ipynb) | Core agents-as-tools patterns, including specialist agents, orchestration, and nested agents |
| [`agents-as-tools-interleaved.ipynb`](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/10-agents-as-tools/agents-as-tools-interleaved.ipynb) | The same orchestration pattern using Claude 4 interleaved thinking between tool calls |

Start with `agent-as-tools.ipynb`, then use the interleaved-thinking notebook for the advanced variant.

## Prerequisites

-   A Python environment with Jupyter
-   AWS credentials configured for Amazon Bedrock
-   Access to the Claude model configured in the notebooks

## Run the notebooks

1.  Install the shared dependencies:
    
    ```bash
    pip install -r requirements.txt
    ```
    
2.  Start Jupyter from this directory:
    
    ```bash
    jupyter notebook
    ```
    
3.  Open a notebook and run its cells in order.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/10-agents-as-tools)
