// @ts-nocheck
// Imports for client-tools page snippets

// --8<-- [start:define_imports]
import { Agent, ClientTool } from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:define_imports]

// --8<-- [start:resume_imports]
import {
  Agent,
  ClientTool,
  InterruptResponseContent,
  isClientToolInterrupt,
} from '@strands-agents/sdk'
import type { JSONValue } from '@strands-agents/sdk'
// --8<-- [end:resume_imports]

// --8<-- [start:error_imports]
import { Agent, ClientTool, InterruptResponseContent } from '@strands-agents/sdk'
// --8<-- [end:error_imports]

// --8<-- [start:server_client_imports]
import {
  Agent,
  ClientTool,
  isClientToolInterrupt,
  SessionManager,
} from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import type { InvokeArgs, JSONValue } from '@strands-agents/sdk'
// --8<-- [end:server_client_imports]

// --8<-- [start:long_running_imports]
import {
  Agent,
  ClientTool,
  InterruptResponseContent,
  isClientToolInterrupt,
  SessionManager,
} from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import type { JSONValue } from '@strands-agents/sdk'
// --8<-- [end:long_running_imports]
