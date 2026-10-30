// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:graph_import]
import { Agent } from '@strands-agents/sdk'
import { graph } from '@strands-agents/sdk/vended-tools/graph'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
// --8<-- [end:graph_import]

// --8<-- [start:graph_custom_import]
import { Agent } from '@strands-agents/sdk'
import { Choice, Preset } from '@strands-agents/sdk/multiagent'
import { makeGraph } from '@strands-agents/sdk/vended-tools/graph'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
// --8<-- [end:graph_custom_import]
