This tutorial demonstrates how to persist agent conversation state across restarts using the Strands Agents session management system. You’ll progress from a stateless baseline to file-based, S3-based, and custom DynamoDB backends, then apply session persistence to multi-agent patterns.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | `SessionManager`, `FileSessionManager`, `S3SessionManager`, `SessionRepository`, `Swarm`, `Graph` |
| **Agent Pattern** | Single agent, Swarm, Graph |
| **Tools** | None |
| **Model** | Default Bedrock model |

## Key Concepts

-   **SessionManager**: Abstract interface that hooks into agent lifecycle events to persist conversation state automatically
-   **FileSessionManager**: Built-in backend that stores sessions as JSON files on the local filesystem
-   **S3SessionManager**: Built-in backend that stores sessions in an S3 bucket for cloud-based persistence
-   **SessionRepository**: Abstract interface for implementing custom storage backends (e.g., DynamoDB)
-   **Multi-agent sessions**: Session persistence applied to Swarm and Graph orchestration patterns

## Prerequisites

-   Python 3.10 or higher
-   AWS account with Amazon Bedrock [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-modify.html) enabled
-   AWS credentials configured through the standard boto3 credential chain (environment variables, `~/.aws/credentials`, or an attached IAM role). Both notebooks include a setup cell that derives the region and account ID from the active credentials.
-   IAM permissions for Amazon S3 and Amazon DynamoDB — the notebooks create and then delete a bucket and a table

## Tutorial Structure

| Notebook | Description |
| --- | --- |
| [01-single-agent-persistence.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/20-session-management/01-single-agent-persistence.ipynb) | Baseline failure → FileSessionManager → S3 backend → custom DynamoDB backend |
| [02-multi-agent-persistence.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/20-session-management/02-multi-agent-persistence.ipynb) | Session persistence with Swarm and Graph patterns |

### Notebook 1 walkthrough

1.  **Baseline** — see an agent lose memory on restart (a few cells)
2.  **FileSessionManager** — persist to the local filesystem, inspect the files, restore
3.  **S3SessionManager** — swap the backend constructor, everything else stays the same
4.  **DynamoDB** (advanced) — implement `SessionRepository` for a custom single-table design

### Notebook 2 walkthrough

1.  **Swarm** — two collaborating agents with `S3SessionManager` on the orchestrator
2.  **Graph** — deterministic three-node pipeline with `FileSessionManager` on the orchestrator

## Getting Started

1.  **Install dependencies:**
    
    ```bash
    pip install -r requirements.txt
    ```
    
2.  **Run the notebooks in order:**
    
    -   **Notebook 1**: Persist a single agent’s conversation with each of the three backends
    -   **Notebook 2**: Persist Swarm and Graph orchestration state
3.  **Verify persistence works** — in each section, a restore cell creates a brand-new agent with the same session ID and asks about a detail shared earlier. The agent answers correctly only because the state was loaded from the backend.
    

## Project Structure

```plaintext
20-session-management/
├── README.md
├── requirements.txt
├── 01-single-agent-persistence.ipynb
└── 02-multi-agent-persistence.ipynb
```

## Cleanup

-   **FileSessionManager**: Delete the `sessions/` folder created during the notebook run.
-   **S3SessionManager** (notebook 01): The cleanup cell deletes the session objects and bucket.
-   **S3SessionManager** (notebook 02 Swarm): The cleanup cell deletes the swarm session bucket.
-   **DynamoDB**: The cleanup cell in notebook 01 deletes the DynamoDB table.

## Additional Resources

-   [Strands Agents Documentation](https://strandsagents.com/)
-   [SessionManager API Reference](https://strandsagents.com/docs/api/python/strands.session.session_manager/)
-   [FileSessionManager API Reference](https://strandsagents.com/docs/api/python/strands.session.file_session_manager/)
-   [S3SessionManager API Reference](https://strandsagents.com/docs/api/python/strands.session.s3_session_manager/)
-   [SessionRepository API Reference](https://strandsagents.com/docs/api/python/strands.session.session_repository/)

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/20-session-management)
