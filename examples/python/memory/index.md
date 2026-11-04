This tutorial demonstrates how to build Strands Agents that can remember information across multiple interactions by leveraging persistent memory. With memory persistence, your agent can maintain context and recall information from previous conversations, even after being restarted.

## Key Concepts

-   **Agent Memory**: Enables agents to store and recall information from previous conversations
-   **Persistence**: Information remains available even after restarting the agent
-   **Vector Storage**: Uses vector embeddings to store and retrieve semantically similar information
-   **Implementation**: Uses the `mem0_memory` tool from [mem0.ai](https://mem0.ai)

## Memory Backend Options

This tutorial supports three different memory backend configurations:

1.  **OpenSearch Serverless** (Recommended for AWS environments):
    
    -   Fully managed AWS service for vector storage
    -   Requires AWS credentials and permissions
    -   Automatically deployed with the provided scripts
2.  **FAISS** (Default for local development):
    
    -   Local vector store that doesn’t require external services
    -   Suitable for development and testing
    -   Memory is lost when the process ends
3.  **Mem0 Platform**:
    
    -   Cloud-based memory service from [mem0.ai](https://mem0.ai)
    -   Requires a Mem0 API key
    -   See notebook for configuration details

## Use Cases

-   Personal assistants that remember user preferences
-   Customer support bots that maintain conversation context
-   Educational agents that track learning progress
-   Enterprise assistants that recall company-specific information
-   Any application where conversation history adds value

## Getting Started

### Prerequisites

-   Python 3.10+
-   AWS account with appropriate permissions (for OpenSearch option)
-   Anthropic Claude model enabled on Amazon Bedrock

### Option 1: Interactive Notebook

Run through the included Jupyter notebook to understand memory concepts and implementation with Strands agents: `./personal_agent_with_memory.ipynb`

### Option 2: Command Line Demo

For an interactive chat experience:

1.  Install dependencies:
    
    ```plaintext
    pip install -r requirements.txt
    ```
    
2.  Create the OpenSearch serverless resources:
    
    ```plaintext
    sh prereqs/deploy_OSS.sh
    ```
    
3.  Launch the agent:
    
    ```plaintext
    python personal_agent_with_memory.py
    ```
    
4.  Interact with the agent by asking questions or providing information:
    
    -   Try “Remember that I prefer tea over coffee”
    -   Later ask “What do I prefer to drink?”
    -   Say “memory” to list all stored memories
5.  When done, delete the OpenSearch resources:
    
    ```plaintext
    sh prereqs/cleanup_OSS.sh
    ```
    

## Memory Operations

The agent supports three primary memory operations:

-   **store**: Save important information for later retrieval
-   **retrieve**: Access relevant memories based on queries
-   **list**: View all stored memories

## Experiment Ideas

-   Tell the agent personal facts and verify recall in later conversations
-   Test memory persistence by restarting the agent between interactions
-   Compare with non-persistent agents to see the difference in user experience
-   Try different types of information to see what the agent remembers best
-   Explore how the agent uses memories to provide more personalized responses

## Architecture

The tutorial demonstrates two possible architectures:

1.  **OpenSearch Serverless**: AWS-managed vector database for production use
2.  **Mem0 Platform**: Cloud-based memory service for simplified deployment

See the notebook for architecture diagrams and detailed explanations.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/06-memory)
