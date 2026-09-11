import { Agent, SessionManager } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { InMemoryStorage, LocalFileStorage, S3Storage } from '@strands-agents/sdk/storage'

async function agentLevel() {
  // --8<-- [start:agent_level]
  const storage = new S3Storage('my-bucket', {
    prefix: 'agents/prod/',
  })

  const agent = new Agent({
    storage,
    sessionManager: new SessionManager({
      sessionId: 'my-session',
    }),
    contextManager: 'auto',
  })
  // --8<-- [end:agent_level]
}

async function perPlugin() {
  // --8<-- [start:per_plugin]
  const agent = new Agent({
    sessionManager: new SessionManager({
      sessionId: 'my-session',
      storage: new S3Storage('my-bucket'),
    }),
    plugins: [
      new ContextOffloader({
        storage: new InMemoryStorage(),
      }),
    ],
  })
  // --8<-- [end:per_plugin]
}

async function inMemory() {
  // --8<-- [start:in_memory]
  const storage = new InMemoryStorage()
  // --8<-- [end:in_memory]
}

async function localFile() {
  // --8<-- [start:local_file]
  const storage = new LocalFileStorage('./my-data/')
  // --8<-- [end:local_file]
}

async function s3() {
  // --8<-- [start:s3]
  const storage = new S3Storage('my-bucket', {
    prefix: 'agents/prod/',
  })
  // --8<-- [end:s3]
}
