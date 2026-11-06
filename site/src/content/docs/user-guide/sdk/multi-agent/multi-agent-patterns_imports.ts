// @ts-nocheck: snippets re-import Agent so each rendered example is self-contained

// --8<-- [start:agents_as_tools_hub_imports]
import { Agent } from '@strands-agents/sdk'
// --8<-- [end:agents_as_tools_hub_imports]

// --8<-- [start:supervisor_imports]
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Agent } from '@strands-agents/sdk'
import type { InterruptResponseContentData } from '@strands-agents/sdk'
import {
  BeforeNodeCallEvent,
  Graph,
  NodeCancelEvent,
  Status,
} from '@strands-agents/sdk/multiagent'
// --8<-- [end:supervisor_imports]

// --8<-- [start:invocation_state_graph_imports]
import { Agent } from '@strands-agents/sdk'
import { Graph } from '@strands-agents/sdk/multiagent'
// --8<-- [end:invocation_state_graph_imports]

// --8<-- [start:invocation_state_tool_imports]
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:invocation_state_tool_imports]

// --8<-- [start:multi_agent_state_imports]
import { Agent } from '@strands-agents/sdk'
import { BeforeNodeCallEvent, Graph } from '@strands-agents/sdk/multiagent'
// --8<-- [end:multi_agent_state_imports]
