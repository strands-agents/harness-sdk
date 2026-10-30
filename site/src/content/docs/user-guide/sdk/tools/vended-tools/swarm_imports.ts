// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:swarm_import]
import { Agent } from '@strands-agents/sdk'
import { swarm } from '@strands-agents/sdk/vended-tools/swarm'
// --8<-- [end:swarm_import]

// --8<-- [start:swarm_custom_import]
import { Agent } from '@strands-agents/sdk'
import { Choice, Fixed, Inherit, Preset } from '@strands-agents/sdk/multiagent'
import { makeSwarm } from '@strands-agents/sdk/vended-tools/swarm'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
// --8<-- [end:swarm_custom_import]
