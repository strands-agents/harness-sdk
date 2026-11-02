// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:python_repl_import]
import { Agent } from '@strands-agents/sdk'
import { pythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'
// --8<-- [end:python_repl_import]

// --8<-- [start:python_repl_custom_import]
import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makePythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'
// --8<-- [end:python_repl_custom_import]
