---
title: "First Agent"
description: "Create your first agent with TypeScript."
sampleId: "typescript/01-learn/01-first-agent"
slug: "typescript/first-agent"
language: "typescript"
category: "learn"
categoryLabel: "Learn"
tags: []
sourceRepository: "strands-agents/samples"
sourceCommit: "47af0dbd720ef4812a1bf0cdea8572c07750e68e"
sourcePath: "typescript/01-learn/01-first-agent"
guidePath: "README.md"
guideKind: "readme"
categoryOrder: 8
sampleOrder: 80
---

This example creates a minimal Strands agent with TypeScript and Amazon Bedrock.

## Prerequisites

- Node.js 22 or later
- AWS credentials with Amazon Bedrock model access

## Run the example

```bash
cd typescript/01-learn/01-first-agent
npm install
npx tsx src/firstAgent.ts
```

The agent sends a prompt to the configured model and streams its response to the terminal.
