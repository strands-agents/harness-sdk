// @ts-nocheck
// NOTE: Type-checking is disabled because the interrupt feature is not yet published in the installed SDK.

// --8<-- [start:hooks_before_tool_call_imports]
import { Agent, tool, BeforeToolCallEvent } from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:hooks_before_tool_call_imports]

// --8<-- [start:hooks_before_tools_imports]
import { Agent, BeforeToolsEvent } from '@strands-agents/sdk'
// --8<-- [end:hooks_before_tools_imports]

// --8<-- [start:hooks_before_model_call_imports]
import { Agent, BeforeModelCallEvent } from '@strands-agents/sdk'
// --8<-- [end:hooks_before_model_call_imports]

// --8<-- [start:tools_example_imports]
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:tools_example_imports]

// --8<-- [start:session_management_imports]
import {
  Agent,
  tool,
  SessionManager,
  FileStorage,
  BeforeToolCallEvent,
} from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:session_management_imports]

// --8<-- [start:multiagent_swarm_imports]
import { Agent, Swarm, Status, BeforeNodeCallEvent } from '@strands-agents/sdk'
// --8<-- [end:multiagent_swarm_imports]

// --8<-- [start:multiagent_graph_imports]
import { Agent, Graph, Status, BeforeNodeCallEvent } from '@strands-agents/sdk'
// --8<-- [end:multiagent_graph_imports]
