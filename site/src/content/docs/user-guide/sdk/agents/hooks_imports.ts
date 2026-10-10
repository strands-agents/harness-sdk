// @ts-nocheck

// --8<-- [start:hook_ordering_imports]
import { Agent, HookOrder, BeforeToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:hook_ordering_imports]

// --8<-- [start:tool_interception_imports]
import {
  BeforeToolCallEvent,
  type LocalAgent,
  type Plugin,
  type FunctionTool,
} from '@strands-agents/sdk'
// --8<-- [end:tool_interception_imports]

// --8<-- [start:result_modification_imports]
import {
  AfterToolCallEvent,
  ToolResultBlock,
  TextBlock,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'
// --8<-- [end:result_modification_imports]

// --8<-- [start:logging_modifications_imports]
import {
  AfterToolCallEvent,
  ToolResultBlock,
  TextBlock,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'
// --8<-- [end:logging_modifications_imports]

// --8<-- [start:summarize_after_tools_imports]
import { Agent, AfterInvocationEvent } from '@strands-agents/sdk'
// --8<-- [end:summarize_after_tools_imports]

// --8<-- [start:iterative_refinement_imports]
import { Agent, AfterInvocationEvent } from '@strands-agents/sdk'
// --8<-- [end:iterative_refinement_imports]

// --8<-- [start:auto_approve_interrupts_imports]
import {
  Agent,
  AfterInvocationEvent,
  BeforeToolCallEvent,
  InterruptEvent,
} from '@strands-agents/sdk'
import type { Interrupt } from '@strands-agents/sdk'
// --8<-- [end:auto_approve_interrupts_imports]
