# HTTP Request Tool

A cross-platform HTTP request tool for making HTTP requests to external APIs from Strands agents.

## ⚠️ Security Warning

**This tool makes HTTP requests to arbitrary URLs without restrictions on destination.**

- Only use with trusted input
- Requests execute with the network access of the host process
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users or untrusted prompt input without additional security measures

## Features

- **All HTTP Methods**: Supports GET, POST, PUT, DELETE, PATCH, HEAD, and OPTIONS
- **Cross-Platform**: Uses native `fetch` API - works in Node.js 22+ and all modern browsers
- **Timeout Support**: Configurable request timeout with default of 30 seconds
- **Type-Safe**: Full TypeScript support with Zod schema validation
- **Comprehensive Error Handling**: Network errors, timeouts, and HTTP errors are properly handled

## Installation

```bash
npm install @strands-agents/sdk
```

## Usage

### With an Agent

```typescript
import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({
  tools: [httpRequest],
})

// Agent will use the tool based on your prompts
await agent.invoke('Get data from https://api.example.com/data')
```

### Direct Invocation

```typescript
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

// Simple GET request
const response = await httpRequest.invoke({
  method: 'GET',
  url: 'https://api.example.com/data',
})

console.log(response.status) // 200
console.log(response.body) // Response body as text
```

## API

### Input

The tool accepts an object with the following properties:

| Property  | Type                                                                     | Required | Default | Description                          |
| --------- | ------------------------------------------------------------------------ | -------- | ------- | ------------------------------------ |
| `method`  | `'GET' \| 'POST' \| 'PUT' \| 'DELETE' \| 'PATCH' \| 'HEAD' \| 'OPTIONS'` | Yes      | -       | HTTP method to use                   |
| `url`     | `string`                                                                 | Yes      | -       | URL to send the request to           |
| `headers` | `Record<string, string>`                                                 | No       | -       | Optional HTTP headers                |
| `body`    | `string`                                                                 | No       | -       | Optional request body (for POST/PUT) |
| `timeout` | `number`                                                                 | No       | 30      | Timeout in seconds                   |

### Output

Returns an object with the following properties:

| Property     | Type                     | Description                      |
| ------------ | ------------------------ | -------------------------------- |
| `status`     | `number`                 | HTTP status code                 |
| `statusText` | `string`                 | HTTP status text                 |
| `headers`    | `Record<string, string>` | Response headers as plain object |
| `body`       | `string`                 | Response body as text            |

### Error Handling

The tool throws standard JavaScript Error objects in the following cases:

- **Timeout Error**: Request exceeds the specified timeout (error message includes "Request timed out")
- **HTTP Error**: HTTP response with non-2xx status code (error message includes HTTP status code and status text)
- **Network Errors**: Connection failures, DNS resolution failures, etc.

When used within an agent, these errors are automatically converted to tool execution errors.
