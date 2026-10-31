import type { McpServerInfo } from '../mcp.js'

export function mcpFailure(server: McpServerInfo): { summary: string; guidance: string } {
  const error = server.error ?? ''
  const missingVariable = /Environment variable ["']?([A-Za-z_][A-Za-z0-9_]*)["']? is not set/i.exec(error)?.[1]
  if (missingVariable) {
    return {
      summary: `Missing environment variable: ${missingVariable}`,
      guidance: `Set ${missingVariable} in the environment used to start Strands, then restart Strands. If it comes from --env-file, edit that file, then open /setup and save. Retry cannot import variables from another shell.`,
    }
  }
  if (/\b(?:HTTP(?: HTTP)?|status(?: code)?)\s*[:=]?\s*401\b|unauthorized|requires authorization/i.test(error)) {
    return {
      summary: 'Authentication required',
      guidance:
        'Configure valid credentials for this server in Strands, then open /setup and save or restart Strands. Sign-in saved by another app is not shared. Strands does not offer browser sign-in for MCP servers.',
    }
  }
  if (/\b(?:HTTP(?: HTTP)?|status(?: code)?)\s*[:=]?\s*403\b|forbidden/i.test(error)) {
    return {
      summary: 'Access denied',
      guidance:
        'Check that your credentials have access to this server. After editing credentials in the configuration, open /setup and save or restart Strands.',
    }
  }
  if (/\bENOENT\b/.test(error)) {
    return {
      summary: 'Server command or working directory not found',
      guidance: `Check the server command and working directory. Install the required executable or correct its path. ${retryGuidance(server)}`,
    }
  }
  if (/\bECONNREFUSED\b/.test(error)) {
    return {
      summary: 'Server is not accepting connections',
      guidance: `Check that the server is running and its address is correct. ${retryGuidance(server)}`,
    }
  }
  if (/\bETIMEDOUT\b|timed? ?out|timeout/i.test(error)) {
    return {
      summary: 'Server did not respond in time',
      guidance: `Check the server and network connection. ${retryGuidance(server)}`,
    }
  }
  if (/connection closed|server.*exited|socket hang up/i.test(error)) {
    return {
      summary: 'Server closed the connection',
      guidance: `Check that the server can start with the configured command and environment; open any companion app it requires. ${retryGuidance(server)}`,
    }
  }
  return {
    summary: 'Could not connect to the server',
    guidance: `Review the error below and the server configuration. ${retryGuidance(server)}`,
  }
}

function retryGuidance(server: McpServerInfo): string {
  return server.canRetry === false
    ? 'After fixing the configuration, open /setup and save or restart Strands.'
    : 'Return to the server list and press R to retry. Retry uses the loaded settings. After editing configuration or environment files, open /setup and save or restart Strands.'
}
