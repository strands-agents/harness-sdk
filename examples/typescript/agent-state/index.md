This sample demonstrates how to use agent state to build stateful agents that remember information across interactions.

## Key Concepts

-   **Agent State**: Persistent storage hidden from the model, accessible to tools
-   **Conversation History**: Messages passed to the model for reasoning
-   **Hooks**: Track and respond to agent lifecycle events

## What This Demo Does

![Architecture](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/typescript/01-learn/05-agent-state/images/architecture.png)

Creates a shopping assistant that:

-   Tracks the user ID as part of the agent state
-   Tracks items in a user’s cart in an external store
-   Remembers user preferences
-   Provides tools to add/remove items and view cart
-   Uses hooks to log activity and store conversation history

## Project Structure

```plaintext
src/
├── index.ts      # CLI entry point, conversation loop
├── agent.ts      # Agent configuration, tools, hooks
└── database.ts   # Dummy DB implementation that persists data in a database.json file
```

The database is a simple JSON file-based implementation for demo purposes. In production, you’d use a real database.

## Getting Started

### Prerequisites

-   Node.js 22+ (the version `@strands-agents/sdk` supports)
-   AWS Bedrock access

### Installation

```bash
npm install
```

### Configuration

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1
```

### Build

```bash
npm run build
```

### Run

Run your agent

```bash
npm start YOUR_USER_ID
```

## Testing Journey

Follow this sequence to see state persistence in action:

1.  **Introduce yourself**: “My name is Alex”
2.  **Set preferences**: “I prefer USD currency and cash payment”
3.  **Browse products**: “Show me laptop prices”
4.  **Add items**: “Add a laptop and a mouse to my cart”
5.  **Remove item**: “Remove the mouse, I already have one”
6.  **Exit**: Type “exit”
7.  **Restart**: Run `npm start` again
8.  **Verify persistence**: “What’s my name and what are my preferences?”

The agent should remember your name, preferences, and cart contents across sessions.

## Key Takeaways

-   State persists across invocations but is hidden from the model
-   Tools access state via `context.agent.state`
-   Conversation history is what the model sees
-   Hooks let you track agent behavior

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/typescript/01-learn/05-agent-state)
