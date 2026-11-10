# Browser Agent Example

A browser-based AI agent that can modify DOM elements through natural language commands. Supports OpenAI, Anthropic, and AWS Bedrock.

**⚠️ WARNING: This example is for demonstration purposes only and should NOT be used in production.** The agent executes LLM-generated HTML, CSS, and JavaScript with minimal filtering. While the canvas is sandboxed in an iframe, this pattern is inherently unsafe for untrusted or production environments.

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open the URL (usually `http://localhost:5173`), configure your API credentials in settings, and start chatting.

## How It Works

This example runs a Strands Agent directly in your browser that you can communicate with through the chat window. The agent has access to a custom tool called `update_canvas` that allows it to modify the canvas element displayed in the view with any combination of HTML, CSS, or JavaScript.

When you send a message, the agent streams its response in real-time and decides whether to use the canvas tool based on your request. The agent maintains conversation history, so it understands context from previous messages.

Try asking it:
- "Change the background to blue"
- "Add some cats to the canvas"
- "Add a border and center the text"
