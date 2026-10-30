// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:subagent_import]
import { Agent } from '@strands-agents/sdk'
import { subagent } from '@strands-agents/sdk/vended-tools/subagent'
// --8<-- [end:subagent_import]

// --8<-- [start:subagent_custom_import]
import { Agent } from '@strands-agents/sdk'
import { Choice, Option, Preset } from '@strands-agents/sdk/multiagent'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'
// --8<-- [end:subagent_custom_import]
