// @ts-nocheck
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

async function basicExample() {
  // --8<-- [start:basic_example]
  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const deleteTool = tool({
    name: 'delete_record',
    description: 'Delete a record by ID',
    inputSchema: z.object({ record_id: z.string() }),
    callback: (input) => `Deleted ${input.record_id}`,
  })

  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action == Action::"search", resource);
    `,
  })

  const agent = new Agent({
    tools: [searchTool, deleteTool],
    interventions: [cedar],
  })

  await agent.invoke('Search for quarterly reports then delete record 42')
  // If the agent calls search, it's permitted; a delete_record call is denied (no matching permit)
  // --8<-- [end:basic_example]
}

async function roleBasedExample() {
  // --8<-- [start:role_based]
  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const deleteTool = tool({
    name: 'delete_record',
    description: 'Delete a record by ID',
    inputSchema: z.object({ record_id: z.string() }),
    callback: (input) => `Deleted ${input.record_id}`,
  })

  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action, resource)
      when { context.session.role == "admin" };

      permit(principal, action == Action::"search", resource)
      when { context.session.role == "analyst" };
    `,
    principalResolver: (state) => {
      if (!state.user_id) return undefined
      return { type: 'User', id: String(state.user_id) }
    },
    contextEnricher: ({ invocationState }) => ({
      role: String(invocationState.role ?? 'none'),
    }),
  })

  const agent = new Agent({
    tools: [searchTool, deleteTool],
    interventions: [cedar],
  })

  // admin can use any tool
  await agent.invoke('Delete record 42', {
    invocationState: { user_id: 'alice', role: 'admin' },
  })

  // analyst can only search
  await agent.invoke('Delete record 42', {
    invocationState: { user_id: 'bob', role: 'analyst' },
  })
  // denied: no permit matches for delete_record with role "analyst"
  // --8<-- [end:role_based]
}

async function rateLimitExample() {
  // --8<-- [start:rate_limit]
  const sendEmailTool = tool({
    name: 'send_email',
    description: 'Send an email',
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    callback: (input) => `Sent to ${input.to}`,
  })

  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action == Action::"send_email", resource)
      when { context.session.call_count < 5 };

      permit(principal, action == Action::"search", resource);
    `,
  })

  const agent = new Agent({
    tools: [sendEmailTool, searchTool],
    interventions: [cedar],
  })

  // send_email is permitted for the first 4 calls, then denied on the 5th
  // search is unlimited
  // --8<-- [end:rate_limit]
}

async function schemaValidationExample() {
  // --8<-- [start:schema_validation]
  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const deleteTool = tool({
    name: 'delete_record',
    description: 'Delete a record by ID',
    inputSchema: z.object({ record_id: z.string() }),
    callback: (input) => `Deleted ${input.record_id}`,
  })

  // Valid policies pass schema validation
  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action == Action::"search", resource);
      permit(principal, action == Action::"delete_record", resource)
      when { context.session.role == "admin" };
    `,
    tools: [searchTool, deleteTool],
    contextEnricher: ({ invocationState }) => ({
      role: String(invocationState.role ?? 'none'),
    }),
  })

  // A typo in the action name throws at construction:
  // new CedarAuthorization({
  //   policies: 'permit(principal, action == Action::"deleet_record", resource);',
  //   tools: [searchTool, deleteTool],
  // })
  // throws "Cedar policy validation failed: unrecognized action"
  // --8<-- [end:schema_validation]
}

async function namespaceExample() {
  // --8<-- [start:namespace]
  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const cedar = new CedarAuthorization({
    namespace: 'Agent',
    policies: `
      permit(principal, action == Agent::Action::"search", resource);
    `,
    tools: [searchTool],
    entities: [{ uid: { type: 'Agent::Resource', id: 'default' }, attrs: {}, parents: [] }],
    principalResolver: (state) => {
      if (!state.user_id) return undefined
      return { type: 'Agent::User', id: String(state.user_id) }
    },
  })

  const agent = new Agent({
    tools: [searchTool],
    interventions: [cedar],
  })

  await agent.invoke('Search for reports', {
    invocationState: { user_id: 'alice' },
  })
  // --8<-- [end:namespace]
}

async function envGatingExample() {
  // --8<-- [start:env_gating]
  const deployTool = tool({
    name: 'deploy',
    description: 'Deploy the service',
    inputSchema: z.object({ version: z.string() }),
    callback: (input) => `Deployed ${input.version}`,
  })

  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action == Action::"deploy", resource)
      when { context.session has environment &&
             ["staging", "dev"].contains(context.session.environment) };
    `,
    contextEnricher: ({ invocationState }) => ({
      environment: String(invocationState.environment ?? 'unknown'),
    }),
  })

  const agent = new Agent({
    tools: [deployTool],
    interventions: [cedar],
  })

  // works in staging
  await agent.invoke('Deploy the service', {
    invocationState: { environment: 'staging' },
  })

  // denied in production
  await agent.invoke('Deploy the service', {
    invocationState: { environment: 'production' },
  })

  // denied when environment is absent: the enricher falls back to
  // 'unknown', which is outside the permitted set
  await agent.invoke('Deploy the service')
  // --8<-- [end:env_gating]
}

async function filePoliciesExample() {
  // --8<-- [start:file_policies]
  const cedar = new CedarAuthorization({
    policies: './policies/agent.cedar',
    entities: './policies/entities.json',
  })
  // --8<-- [end:file_policies]
}

async function hotReloadExample() {
  // --8<-- [start:hot_reload]
  const searchTool = tool({
    name: 'search',
    description: 'Search for information',
    inputSchema: z.object({ query: z.string() }),
    callback: (input) => `Results for: ${input.query}`,
  })

  const cedar = new CedarAuthorization({
    policies: './policies/agent.cedar',
  })

  const agent = new Agent({
    tools: [searchTool],
    interventions: [cedar],
  })

  // After editing agent.cedar on disk:
  cedar.reload()
  // Validates new policies before applying. Throws if invalid.
  // --8<-- [end:hot_reload]
}

// suppress unused warnings
void basicExample
void roleBasedExample
void rateLimitExample
void schemaValidationExample
void namespaceExample
void envGatingExample
void filePoliciesExample
void hotReloadExample
