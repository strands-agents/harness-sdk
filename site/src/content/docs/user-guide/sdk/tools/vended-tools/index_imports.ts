// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:basic_import]
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { edit } from '@strands-agents/sdk/vended-tools/edit'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { notebook, makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:basic_import]

// --8<-- [start:combined_import]
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:combined_import]

// --8<-- [start:multi_agent_tools_import]
import { Agent } from '@strands-agents/sdk'
import { Choice, Fixed, Inherit, Open, Preset } from '@strands-agents/sdk/multiagent'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'
// --8<-- [end:multi_agent_tools_import]

// --8<-- [start:custom_builder_import]
import { Agent } from '@strands-agents/sdk'
import type { AgentSpec } from '@strands-agents/sdk/multiagent'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'
// --8<-- [end:custom_builder_import]
