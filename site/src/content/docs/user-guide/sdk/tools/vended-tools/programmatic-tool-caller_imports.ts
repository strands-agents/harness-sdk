// @ts-nocheck
// Import snippets: intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:programmatic_tool_caller_import]
import { Agent } from '@strands-agents/sdk'
import { programmaticToolCaller } from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'
import { read } from '@strands-agents/sdk/vended-tools/read'
// --8<-- [end:programmatic_tool_caller_import]

// --8<-- [start:programmatic_tool_caller_custom_import]
import { Agent } from '@strands-agents/sdk'
import { makeProgrammaticToolCaller } from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'
import { read } from '@strands-agents/sdk/vended-tools/read'
import { write } from '@strands-agents/sdk/vended-tools/write'
// --8<-- [end:programmatic_tool_caller_custom_import]

// --8<-- [start:programmatic_tool_caller_stream_import]
import { Agent } from '@strands-agents/sdk'
import {
  programmaticToolCaller,
  type ProgrammaticToolCallerPrintEvent,
} from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'
import { read } from '@strands-agents/sdk/vended-tools/read'
// --8<-- [end:programmatic_tool_caller_stream_import]
